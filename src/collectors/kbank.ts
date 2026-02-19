import axios from 'axios';
import * as cheerio from 'cheerio';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const KBANK_URL =
    'https://www.kasikornbank.com/en/rate/pages/foreign-exchange.aspx';

const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY;

/**
 * KBANK requires a headless browser because kasikornbank.com uses
 * Akamai CDN which blocks server-side requests.
 * 
 * Uses Browserless.io /function endpoint to run a Puppeteer script
 * with stealth mode — more reliable than /content endpoint.
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
            // Try alternative: look for div-based rate layout
            console.warn('KBANK: No table rows found, trying alt selectors');
            const altRates = this.parseAlternativeLayout($, runId, rateDate);
            if (altRates.length > 0) return { rates: altRates, rateDate };

            console.warn('KBANK: No rate data found in HTML');
            // Log a snippet for debugging
            console.log('KBANK HTML preview:', html.substring(0, 500));
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

    /**
     * Try to extract rates from non-table layout (e.g., div-based cards)
     */
    private parseAlternativeLayout(
        $: cheerio.CheerioAPI,
        runId: string,
        rateDate: string,
    ): ExchangeRateInsert[] {
        const rates: ExchangeRateInsert[] = [];

        // Try: look for any element containing currency codes + numbers
        $('[class*="rate"], [class*="currency"], [class*="exchange"]').each((_, el) => {
            const text = $(el).text();
            const currMatch = text.match(/([A-Z]{3})/);
            const numMatch = text.match(/(\d+\.\d{2,})/g);

            if (currMatch && numMatch && numMatch.length >= 2) {
                const currency = currMatch[1];
                if (!shouldIncludeCurrency(this.name, currency)) return;

                rates.push({
                    run_id: runId,
                    rate_date: rateDate,
                    source: this.name,
                    currency,
                    currency_label: currency,
                    buy_tt: this.parseNumber(numMatch[0]),
                    sell_tt: this.parseNumber(numMatch[numMatch.length - 1]),
                    bank_timestamp: new Date().toISOString(),
                    raw_data: { text: text.trim() },
                });
            }
        });

        return rates;
    }

    private async fetchHtml(): Promise<string | null> {
        // Strategy 1: Browserless.io /function endpoint with stealth
        if (BROWSERLESS_API_KEY) {
            try {
                const result = await this.fetchViaBrowserlessFunction();
                if (result) return result;
            } catch (err) {
                console.error('KBANK Browserless /function failed:', err);
            }

            // Fallback: Browserless /content endpoint
            try {
                const result = await this.fetchViaBrowserlessContent();
                if (result) return result;
            } catch (err) {
                console.error('KBANK Browserless /content failed:', err);
            }
        }

        // Strategy 2: Direct fetch (likely blocked but try)
        try {
            const { data } = await axios.get(KBANK_URL, {
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'text/html',
                    'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
                    Referer: 'https://www.google.com/',
                },
                timeout: 15000,
            });
            return data;
        } catch (err) {
            console.error('KBANK direct fetch failed:', err);
            return null;
        }
    }

    /**
     * Browserless /function endpoint — runs a Puppeteer script on the server.
     * This is more reliable because:
     * 1. We can use stealth plugin behaviors
     * 2. We can wait for specific content
     * 3. We can interact with the page
     */
    private async fetchViaBrowserlessFunction(): Promise<string | null> {
        const functionUrl = `https://chrome.browserless.io/function?token=${BROWSERLESS_API_KEY}`;

        const code = `
            export default async function ({ page }) {
                // Set stealth-like properties
                await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                });
                await page.setViewport({ width: 1920, height: 1080 });

                // Navigate to KBANK
                await page.goto('${KBANK_URL}', {
                    waitUntil: 'networkidle2',
                    timeout: 25000,
                });

                // Wait for rate table to appear
                try {
                    await page.waitForSelector('table tbody tr', { timeout: 15000 });
                } catch (e) {
                    // Maybe the table uses different markup
                    console.log('No table found, trying to wait more...');
                    await page.waitForTimeout(5000);
                }

                // Get full page HTML
                const html = await page.content();
                return { data: html, type: 'application/html' };
            }
        `;

        const { data } = await axios.post(
            functionUrl,
            { code },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 45000,
            }
        );

        return typeof data === 'string' ? data : data?.data || null;
    }

    /**
     * Browserless /content endpoint — simpler but less control
     */
    private async fetchViaBrowserlessContent(): Promise<string | null> {
        const contentUrl = `https://chrome.browserless.io/content?token=${BROWSERLESS_API_KEY}`;

        const { data } = await axios.post(
            contentUrl,
            {
                url: KBANK_URL,
                bestAttempt: true,
                waitForSelector: {
                    selector: 'table tbody tr',
                    timeout: 15000,
                },
                gotoOptions: {
                    waitUntil: 'networkidle2',
                    timeout: 25000,
                },
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: 45000,
            }
        );

        return data || null;
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
