import puppeteer from 'puppeteer-core';
import { ExchangeRateInsert } from '@/lib/supabase';
import { generateRunId } from './base';

export interface KbankBrowserlessResult {
    rates: ExchangeRateInsert[];
    bankTimestamp: string | null;
    rateDate: string;
    round: string | null;
    rawDateStr: string;
    durationMs: number;
    matchedCount: number;
}

const TARGETS = [
    'USD', 'AED', 'AUD', 'BHD', 'BND', 'CAD', 'CHF', 'CNY', 'DKK', 'EUR',
    'GBP', 'HKD', 'IDR', 'INR', 'JPY', 'KRW', 'MYR', 'NOK', 'NZD', 'PHP',
    'SAR', 'SEK', 'SGD', 'TWD', 'VND', 'ZAR'
];

/**
 * Fetches KBANK exchange rates directly via Browserless.io Remote Headless Chrome
 * with built-in stealth mode to bypass Akamai Bot Manager.
 */
export async function fetchKbankViaBrowserless(): Promise<KbankBrowserlessResult> {
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY environment variable');

    const t0 = Date.now();
    const endpoint = `wss://chrome.browserless.io?token=${apiKey}&stealth=true`;

    const browser = await puppeteer.connect({
        browserWSEndpoint: endpoint,
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.goto('https://www.kasikornbank.com/en/rate/pages/foreign-exchange.aspx', {
            waitUntil: 'domcontentloaded',
            timeout: 35000,
        });

        await page.waitForSelector('#table-exchangerate', { timeout: 15000 });

        const rawData = await page.evaluate(() => {
            const dateEl = document.querySelector('p.date-data');
            const dateStr = dateEl ? (dateEl as HTMLElement).innerText.trim() : '';

            const rows = Array.from(document.querySelectorAll('#table-exchangerate tbody tr')).map(tr => {
                return Array.from(tr.querySelectorAll('td')).map(td => (td as HTMLElement).innerText.trim());
            });

            return { dateStr, rows };
        });

        const durationMs = Date.now() - t0;

        // Parse Bank Timestamp and Round
        // e.g. "Date 27 October 2026 Time 11:17:59 Round 4"
        const m = rawData.dateStr.match(/Date\s+(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+Time\s+(\d{1,2}:\d{2}:\d{2})\s+Round\s+(\d+)/i);
        let bankTimestamp: string | null = null;
        let rateDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        let round: string | null = null;

        if (m) {
            const day = m[1].padStart(2, '0');
            const monthNames = [
                'january', 'february', 'march', 'april', 'may', 'june',
                'july', 'august', 'september', 'october', 'november', 'december'
            ];
            const monthIdx = monthNames.indexOf(m[2].toLowerCase()) + 1;
            const month = String(monthIdx).padStart(2, '0');
            const year = m[3];
            const time = m[4];
            round = m[5];
            bankTimestamp = `${year}-${month}-${day}T${time}+07:00`;
            rateDate = `${year}-${month}-${day}`;
        }

        const parseNum = (v: string): number | undefined => {
            if (!v || v === '-' || isNaN(parseFloat(v))) return undefined;
            return parseFloat(v.replace(/,/g, ''));
        };

        const runId = generateRunId();
        const rates: ExchangeRateInsert[] = [];
        const seen = new Set<string>();

        for (const tds of rawData.rows) {
            if (tds.length < 6) continue;
            const curCell = tds[0];
            const codeMatch = curCell.match(/^([A-Z]{3})/);
            if (!codeMatch) continue;

            const code = codeMatch[1];
            if (!TARGETS.includes(code)) continue;

            // USD: Use 50-100 tier
            if (code === 'USD' && !curCell.includes('50-100')) {
                continue;
            }

            if (seen.has(code)) continue;
            seen.add(code);

            const exportSight = parseNum(tds[1]);
            const telexBuy = parseNum(tds[2]);
            const notesBuy = parseNum(tds[3]);
            const ttSell = parseNum(tds[4]);
            const notesSell = parseNum(tds[5]);

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: 'KBANK',
                currency: code,
                currency_label: code === 'USD' ? 'US Dollar (50-100)' : curCell.replace(/\n/g, ' '),
                sell_tt: ttSell,
                sell_notes: notesSell,
                buy_tt: telexBuy,
                buy_sight: exportSight,
                buy_transfer: 0,
                buy_notes: notesBuy,
                bank_timestamp: bankTimestamp || undefined,
                raw_data: {
                    rawCell: curCell,
                    tds,
                    dateStr: rawData.dateStr,
                    round,
                },
            });
        }

        return {
            rates,
            bankTimestamp,
            rateDate,
            round,
            rawDateStr: rawData.dateStr,
            durationMs,
            matchedCount: rates.length,
        };
    } finally {
        await browser.close().catch(() => {});
    }
}
