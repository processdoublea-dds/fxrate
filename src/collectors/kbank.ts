import axios from 'axios';
import * as cheerio from 'cheerio';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const KBANK_URL =
    'https://www.kasikornbank.com/en/rate/pages/foreign-exchange.aspx';

const BROWSERLESS_URL = process.env.BROWSERLESS_API_KEY
    ? `https://chrome.browserless.io/content?token=${process.env.BROWSERLESS_API_KEY}`
    : null;

/**
 * KBANK requires Browserless.io because kasikornbank.com blocks
 * server-side requests with Akamai CDN (403 Forbidden).
 */
export class KbankCollector implements Collector {
    name = 'KBANK';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const html = await this.fetchHtml();
        if (!html) {
            console.warn('KBANK: Could not fetch page HTML');
            return { rates: [], rateDate };
        }

        const rates: ExchangeRateInsert[] = [];
        const $ = cheerio.load(html);

        // Find the exchange rate table
        const rows = $('table tbody tr').filter((_, row) => {
            const text = $(row).text();
            return /[A-Z]{3}/.test(text) && /\d+\./.test(text);
        });

        if (rows.length === 0) {
            console.warn('KBANK: No rate rows found in HTML');
            return { rates: [], rateDate };
        }

        rows.each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 4) return;

            const texts = cells.map((__, c) => $(c).text().trim()).get();

            // Find currency code in first few cells
            let currency = '';
            let currencyLabel = '';
            let startIdx = 0;

            for (let i = 0; i < Math.min(texts.length, 3); i++) {
                const match = texts[i].match(/^([A-Z]{3}\d?)(?:\s+(.*))?$/);
                if (match) {
                    currency = match[1];
                    currencyLabel = match[2] || '';
                    startIdx = i + 1;
                    break;
                }
            }

            if (!currency) return;
            if (!shouldIncludeCurrency(this.name, currency.toUpperCase())) return;

            const values = texts.slice(startIdx);

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency: currency.toUpperCase(),
                currency_label: currencyLabel || currency,
                buy_tt: this.parseNumber(values[0]),
                buy_sight: this.parseNumber(values[1]),
                buy_notes: this.parseNumber(values[2]),
                sell_tt: this.parseNumber(values[3]),
                sell_notes: this.parseNumber(values[4]),
                bank_timestamp: new Date().toISOString(),
                raw_data: { cells: texts },
            });
        });

        return { rates, rateDate };
    }

    private async fetchHtml(): Promise<string | null> {
        // Strategy 1: Browserless.io (headless browser)
        if (BROWSERLESS_URL) {
            try {
                const { data } = await axios.post(
                    BROWSERLESS_URL,
                    {
                        url: KBANK_URL,
                        waitForSelector: {
                            selector: 'table tbody tr',
                            timeout: 20000,
                        },
                        gotoOptions: {
                            waitUntil: 'networkidle2',
                            timeout: 30000,
                        },
                    },
                    {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 60000,
                    }
                );
                return data;
            } catch (err) {
                console.error('KBANK Browserless fetch failed:', err);
            }
        }

        // Strategy 2: Direct fetch (likely blocked but try anyway)
        try {
            const { data } = await axios.get(KBANK_URL, {
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'text/html',
                    'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
                    Referer: 'https://www.google.com/',
                },
                timeout: 30000,
            });
            return data;
        } catch (err) {
            console.error('KBANK direct fetch failed:', err);
            return null;
        }
    }

    private parseNumber(val: unknown): number | undefined {
        if (val === null || val === undefined || val === '' || val === '-' || val === 'N/A') {
            return undefined;
        }
        const str = String(val).replace(/,/g, '');
        const num = Number(str);
        return isNaN(num) ? undefined : num;
    }
}
