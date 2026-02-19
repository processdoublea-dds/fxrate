import axios from 'axios';
import * as cheerio from 'cheerio';
import { Collector, CollectorResult, getPreviousBusinessDate, generateRunId } from './base';
import { ExchangeRateInsert } from '../lib/supabase';

const BLOOMBERG_QUOTES = [
    { pair: 'USDTHB', url: 'https://www.bloomberg.com/quote/USDTHB:CUR', isConversion: true },
    { pair: 'USDBTN', url: 'https://www.bloomberg.com/quote/USDBTN:CUR', currency: 'BTN' },
    { pair: 'USDMNT', url: 'https://www.bloomberg.com/quote/USDMNT:CUR', currency: 'MNT' },
];

const BROWSERLESS_URL = process.env.BROWSERLESS_API_KEY
    ? `https://chrome.browserless.io/content?token=${process.env.BROWSERLESS_API_KEY}`
    : null;

export class BloombergCollector implements Collector {
    name = 'BLOOMBERG';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getPreviousBusinessDate();

        // Step 1: Fetch all 3 Bloomberg quotes
        const rawRates: Record<string, number> = {};

        for (const quote of BLOOMBERG_QUOTES) {
            try {
                const rate = await this.fetchQuote(quote.url, quote.pair);
                if (rate !== null) {
                    rawRates[quote.pair] = rate;
                    console.log(`Bloomberg ${quote.pair}: ${rate}`);
                }
            } catch (err) {
                console.error(`Bloomberg ${quote.pair} fetch failed:`, err);
            }
        }

        // Step 2: Calculate THB rates
        const usdthb = rawRates['USDTHB'];
        if (!usdthb) {
            console.error('Bloomberg: USDTHB not available, cannot calculate rates');
            return { rates: [], rateDate };
        }

        const rates: ExchangeRateInsert[] = [];

        // BTN rate = USDTHB / USDBTN
        if (rawRates['USDBTN']) {
            const btnRate = usdthb / rawRates['USDBTN'];
            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency: 'BTN',
                currency_label: 'Bhutan Ngultrum',
                mid_rate: Number(btnRate.toFixed(5)),
                bank_timestamp: new Date().toISOString(),
                raw_data: {
                    usdthb,
                    usdbtn: rawRates['USDBTN'],
                    formula: 'USDTHB / USDBTN',
                    calculated: btnRate,
                },
            });
        }

        // MNT rate = USDTHB / USDMNT
        if (rawRates['USDMNT']) {
            const mntRate = usdthb / rawRates['USDMNT'];
            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency: 'MNT',
                currency_label: 'Mongolian Tugrik',
                mid_rate: Number(mntRate.toFixed(5)),
                bank_timestamp: new Date().toISOString(),
                raw_data: {
                    usdthb,
                    usdmnt: rawRates['USDMNT'],
                    formula: 'USDTHB / USDMNT',
                    calculated: mntRate,
                },
            });
        }

        return { rates, rateDate };
    }

    private async fetchQuote(url: string, pair: string): Promise<number | null> {
        // Strategy 1: Try Browserless.io (headless browser as a service)
        if (BROWSERLESS_URL) {
            return this.fetchViaBrowserless(url, pair);
        }

        // Strategy 2: Try direct fetch (may be blocked)
        return this.fetchDirect(url, pair);
    }

    /**
     * Fetch via Browserless.io — cloud headless browser
     */
    private async fetchViaBrowserless(
        url: string,
        pair: string
    ): Promise<number | null> {
        try {
            const { data: html } = await axios.post(
                BROWSERLESS_URL!,
                {
                    url,
                    waitForSelector: {
                        selector: '[class*="price"]',
                        timeout: 30000,
                    },
                    gotoOptions: {
                        waitUntil: 'networkidle2',
                        timeout: 60000,
                    },
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 90000,
                }
            );

            return this.extractRate(html, pair);
        } catch (err) {
            console.error(`Browserless fetch failed for ${pair}:`, err);
            return null;
        }
    }

    /**
     * Fallback: Try direct fetch (Bloomberg may block)
     */
    private async fetchDirect(url: string, pair: string): Promise<number | null> {
        try {
            const { data: html } = await axios.get(url, {
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 30000,
            });

            return this.extractRate(html, pair);
        } catch (err) {
            console.error(`Direct fetch failed for ${pair}:`, err);
            return null;
        }
    }

    /**
     * Extract rate from Bloomberg page HTML
     */
    private extractRate(html: string, pair: string): number | null {
        const $ = cheerio.load(html);

        // Bloomberg price selectors (they change, try multiple)
        const selectors = [
            '[class*="price"]',
            '[data-component="price"]',
            '.priceLarge',
            '.price',
            '[class*="Price"]',
        ];

        for (const selector of selectors) {
            const el = $(selector).first();
            if (el.length) {
                const text = el.text().trim().replace(/,/g, '');
                const num = parseFloat(text);
                if (!isNaN(num) && num > 0) {
                    return num;
                }
            }
        }

        // Regex fallback: find number pattern near pair name
        const regex = new RegExp(
            `${pair}[^\\d]*?(\\d+[,.]?\\d*\\.?\\d+)`,
            'i'
        );
        const match = html.match(regex);
        if (match) {
            const num = parseFloat(match[1].replace(/,/g, ''));
            if (!isNaN(num) && num > 0) return num;
        }

        console.warn(`Could not extract rate for ${pair}`);
        return null;
    }
}
