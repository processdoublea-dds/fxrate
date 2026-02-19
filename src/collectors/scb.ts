import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const SCB_URL =
    'https://www.scb.co.th/services/scb/exchangeRateService/latest.json?_charset_=UTF-8&lang=en&page=2ea9c13a-6fb9-4a75-9abd-87ef79ee71cc%2C907ab931-1989-41b4-b599-10bff5593570';

export class ScbCollector implements Collector {
    name = 'SCB';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const { data } = await axios.get(SCB_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
            timeout: 30000,
        });

        const rates: ExchangeRateInsert[] = [];

        // SCB JSON structure: parse the array of rate objects
        const items = this.parseItems(data);

        for (const item of items) {
            const currency = item.currency?.toUpperCase();
            if (!currency) continue;

            // Apply exclusion filter
            if (!shouldIncludeCurrency(this.name, currency)) continue;

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency,
                currency_label: item.currencyLabel || currency,
                sell_tt: this.parseNumber(item.sellTt),
                sell_notes: this.parseNumber(item.sellNotes),
                buy_tt: this.parseNumber(item.buyTt),
                buy_sight: this.parseNumber(item.buySight),
                buy_transfer: this.parseNumber(item.buyTransfer),
                buy_notes: this.parseNumber(item.buyNotes),
                mid_rate: this.parseNumber(item.midRate),
                bank_timestamp: item.timestamp || new Date().toISOString(),
                raw_data: item.raw,
            });
        }

        return { rates, rateDate };
    }

    private parseItems(data: unknown): ScbItem[] {
        const items: ScbItem[] = [];

        try {
            // SCB JSON: typically an array or object with array of rates
            let rateArray: Record<string, unknown>[] = [];

            if (Array.isArray(data)) {
                rateArray = data;
            } else if (typeof data === 'object' && data !== null) {
                const obj = data as Record<string, unknown>;
                // Try common nested paths
                if (obj.data && Array.isArray(obj.data)) {
                    rateArray = obj.data as Record<string, unknown>[];
                } else if (obj.rates && Array.isArray(obj.rates)) {
                    rateArray = obj.rates as Record<string, unknown>[];
                } else if (obj.result && Array.isArray(obj.result)) {
                    rateArray = obj.result as Record<string, unknown>[];
                } else {
                    // Search nested structure
                    for (const val of Object.values(obj)) {
                        if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                            rateArray = val as Record<string, unknown>[];
                            break;
                        }
                    }
                }
            }

            for (const row of rateArray) {
                items.push({
                    currency: String(
                        row.currency_code ||
                        row.currencyCode ||
                        row.currency ||
                        row.Currency ||
                        row.ccy ||
                        ''
                    ),
                    currencyLabel: String(
                        row.currency_name ||
                        row.currencyName ||
                        row.Currency_Name ||
                        row.ccyName ||
                        ''
                    ),
                    sellTt: row.tt_selling ||
                        row.selling ||
                        row.sell_tt ||
                        row.sellTt ||
                        row.Selling,
                    sellNotes: row.note_selling ||
                        row.selling_note ||
                        row.sell_notes ||
                        row.bank_note_selling,
                    buyTt: row.tt_buying ||
                        row.buying ||
                        row.buy_tt ||
                        row.buyTt ||
                        row.Buying,
                    buySight: row.sight_buying ||
                        row.buying_sight ||
                        row.buy_sight,
                    buyTransfer: row.transfer_buying ||
                        row.buying_transfer ||
                        row.buy_transfer,
                    buyNotes: row.note_buying ||
                        row.buying_note ||
                        row.buy_notes ||
                        row.bank_note_buying,
                    midRate: row.mid_rate || row.midRate,
                    timestamp: String(
                        row.update_date ||
                        row.timestamp ||
                        row.date ||
                        ''
                    ),
                    raw: row,
                });
            }
        } catch (err) {
            console.error('SCB parse error:', err);
        }

        return items;
    }

    private parseNumber(val: unknown): number | undefined {
        if (val === null || val === undefined || val === '' || val === '-') {
            return undefined;
        }
        const num = Number(val);
        return isNaN(num) ? undefined : num;
    }
}

interface ScbItem {
    currency: string;
    currencyLabel: string;
    sellTt: unknown;
    sellNotes: unknown;
    buyTt: unknown;
    buySight: unknown;
    buyTransfer: unknown;
    buyNotes: unknown;
    midRate: unknown;
    timestamp: string;
    raw: Record<string, unknown>;
}
