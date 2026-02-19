import axios from 'axios';
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const KTB_URL = 'https://exchangerate.krungthai.com/counter-rate';

export class KtbCollector implements Collector {
    name = 'KTB';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const { data: html } = await axios.get(KTB_URL, {
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

        // KTB rate table: find table rows with rate data
        // The page uses React but the initial HTML may have the table
        // Try multiple selectors for the rate table
        const tableSelectors = [
            'table tbody tr',
            '.table tbody tr',
            '[class*="rate"] table tbody tr',
            '#react-aria\\:R9al\\:-tabpane-rates table tbody tr',
        ];

        let rows: cheerio.Cheerio<AnyNode> | null = null;

        for (const selector of tableSelectors) {
            const found = $(selector);
            if (found.length > 0) {
                rows = found;
                break;
            }
        }

        if (!rows || rows.length === 0) {
            // Try to find any table with currency data
            $('table').each((_, table) => {
                const $table = $(table);
                const text = $table.text();
                if (text.includes('USD') || text.includes('EUR') || text.includes('GBP')) {
                    rows = $table.find('tbody tr');
                    return false; // break
                }
            });
        }

        if (!rows || rows.length === 0) {
            console.warn('KTB: No rate table found in HTML. Page may require JS rendering.');
            return { rates: [], rateDate };
        }

        rows.each((_, row) => {
            const cells = $(row).find('td');
            if (cells.length < 3) return; // Skip non-data rows

            // Try to extract currency and rates from cells
            // Typical order: Currency | Buying | Selling (with sub-columns)
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
    ): KtbRow | null {
        const texts = cells.map((_, c) => $(c).text().trim()).get();

        // Find the cell with a currency code (3-letter code or code with number)
        let currency = '';
        let currencyLabel = '';
        let startIdx = 0;

        for (let i = 0; i < Math.min(texts.length, 3); i++) {
            const match = texts[i].match(/^([A-Z]{3}\d?)\s*(.*)$/i);
            if (match) {
                currency = match[1];
                currencyLabel = match[2] || texts[i];
                startIdx = i + 1;
                break;
            }
            // Check if it's just a currency name/label
            if (
                texts[i].match(
                    /^(US Dollar|Euro|Japanese Yen|Pound Sterling|Swiss Franc)/i
                )
            ) {
                currencyLabel = texts[i];
            }
        }

        if (!currency) return null;

        // Remaining cells are rates: buy/sell columns
        // Common patterns:
        // [currency, buyTT, buySight, buyTransfer, buyNotes, sellTT, sellNotes]
        // [currency, label, buyTT, sellTT, buySight, sellNotes]
        const values = texts.slice(startIdx);

        return {
            currency,
            currencyLabel,
            buyTt: values[0],
            buySight: values[1],
            buyTransfer: values[2],
            buyNotes: values[3],
            sellTt: values[4],
            sellNotes: values[5],
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

interface KtbRow {
    currency: string;
    currencyLabel: string;
    sellTt?: string;
    sellNotes?: string;
    buyTt?: string;
    buySight?: string;
    buyTransfer?: string;
    buyNotes?: string;
}
