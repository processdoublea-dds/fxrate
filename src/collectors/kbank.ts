import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const KBANK_URL =
    'https://www.kasikornbank.com/en/rate/pages/foreign-exchange.aspx';

export class KbankCollector implements Collector {
    name = 'KBANK';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const { data: html } = await axios.get(KBANK_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,th;q=0.8',
            },
            timeout: 30000,
        });

        const rates: ExchangeRateInsert[] = [];
        const $ = cheerio.load(html);

        // KBANK rate table: look for the exchange rate table
        const tableSelectors = [
            'table.table-exchange-rate tbody tr',
            '.exchange-rate table tbody tr',
            '#ExchangeRate table tbody tr',
            'table tbody tr',
        ];

        let rows: cheerio.Cheerio<AnyNode> | null = null;

        for (const selector of tableSelectors) {
            const found = $(selector);
            if (found.length > 3) {
                // Rate table should have more than 3 rows
                rows = found;
                break;
            }
        }

        if (!rows || rows.length === 0) {
            // Try to find any table with currency info
            $('table').each((_, table) => {
                const $table = $(table);
                const text = $table.text();
                if (
                    (text.includes('USD') || text.includes('EUR')) &&
                    (text.includes('Buying') || text.includes('Selling'))
                ) {
                    rows = $table.find('tbody tr');
                    return false; // break
                }
            });
        }

        if (!rows || rows.length === 0) {
            console.warn('KBANK: No rate table found in HTML');
            return { rates: [], rateDate };
        }

        rows.each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 3) return;

            const parsed = this.parseRow($, cells);
            if (!parsed || !parsed.currency) return;

            const currency = parsed.currency.toUpperCase();
            if (!shouldIncludeCurrency(this.name, currency)) return;

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency,
                currency_label: parsed.currencyLabel || currency,
                sell_tt: this.parseNumber(parsed.sellTt),
                sell_notes: this.parseNumber(parsed.sellNotes),
                buy_tt: this.parseNumber(parsed.buyTt),
                buy_sight: this.parseNumber(parsed.buySight),
                buy_transfer: this.parseNumber(parsed.buyTransfer),
                buy_notes: this.parseNumber(parsed.buyNotes),
                bank_timestamp: new Date().toISOString(),
                raw_data: { cells: cells.map((_, c) => $(c).text().trim()).get() },
            });
        });

        return { rates, rateDate };
    }

    private parseRow(
        $: cheerio.CheerioAPI,
        cells: cheerio.Cheerio<AnyNode>
    ): KbankRow | null {
        const texts = cells.map((_, c) => $(c).text().trim()).get();

        let currency = '';
        let currencyLabel = '';
        let startIdx = 0;

        for (let i = 0; i < Math.min(texts.length, 3); i++) {
            const match = texts[i].match(/^([A-Z]{3}\d?)/i);
            if (match) {
                currency = match[1];
                currencyLabel = texts[i].replace(match[1], '').trim();
                startIdx = i + 1;
                break;
            }
        }

        if (!currency) return null;

        const values = texts.slice(startIdx);

        // KBANK typical: [currency, buyTT, buyDraft, buyNotes, sellTT, sellNotes]
        return {
            currency,
            currencyLabel,
            buyTt: values[0],
            buySight: values[1],
            buyTransfer: values[1],
            buyNotes: values[2],
            sellTt: values[3],
            sellNotes: values[4],
        };
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

interface KbankRow {
    currency: string;
    currencyLabel: string;
    sellTt?: string;
    sellNotes?: string;
    buyTt?: string;
    buySight?: string;
    buyTransfer?: string;
    buyNotes?: string;
}
