import axios from 'axios';
import { Collector, CollectorResult, getPreviousBusinessDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

const BOT_URL =
    'https://www.bot.or.th/content/bot/en/statistics/exchange-rate/jcr:content/root/container/statisticstable2.results.level3cache.json';

export class BotCollector implements Collector {
    name = 'BOT';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getPreviousBusinessDate();

        const { data } = await axios.get(BOT_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
            timeout: 30000,
        });

        const rates: ExchangeRateInsert[] = [];

        // BOT JSON structure: parse the response
        // The JSON has a nested structure — we need to adapt to actual format
        const items = this.parseItems(data);

        for (const item of items) {
            const currency = item.currency?.toUpperCase();
            if (!currency) continue;

            // Apply whitelist filter
            if (!shouldIncludeCurrency(this.name, currency)) continue;

            rates.push({
                run_id: runId,
                rate_date: rateDate,
                source: this.name,
                currency,
                currency_label: item.currencyLabel || currency,
                // Use whichever sell rate we find for ALL sell fields
                sell_tt: this.parseNumber(item.sellTt) ?? this.parseNumber(item.sellNotes),
                sell_notes: this.parseNumber(item.sellNotes) ?? this.parseNumber(item.sellTt),
                // Use whichever buy rate we find for ALL buy fields
                buy_tt: this.parseNumber(item.buyTt) ?? this.parseNumber(item.buyTransfer) ?? this.parseNumber(item.buySight) ?? this.parseNumber(item.buyNotes),
                buy_sight: this.parseNumber(item.buySight) ?? this.parseNumber(item.buyTransfer) ?? this.parseNumber(item.buyTt) ?? this.parseNumber(item.buyNotes),
                buy_transfer: this.parseNumber(item.buyTransfer) ?? this.parseNumber(item.buyTt) ?? this.parseNumber(item.buySight) ?? this.parseNumber(item.buyNotes),
                buy_notes: this.parseNumber(item.buyNotes) ?? this.parseNumber(item.buyTransfer) ?? this.parseNumber(item.buyTt) ?? this.parseNumber(item.buySight),
                mid_rate: this.parseNumber(item.midRate),
                bank_timestamp: item.timestamp || new Date().toISOString(),
                raw_data: item.raw,
            });
        }

        return { rates, rateDate };
    }

    private parseItems(data: Record<string, unknown>): BotItem[] {
        const items: BotItem[] = [];

        try {
            // BOT JSON structure varies — try common patterns
            // Pattern: data.result.data.data_detail or data.result
            const result = data as Record<string, unknown>;

            // Try to find data array in nested structure
            let dataArray: Record<string, unknown>[] = [];

            if (Array.isArray(result)) {
                dataArray = result;
            } else if (result.result && Array.isArray((result.result as Record<string, unknown>).data)) {
                dataArray = (result.result as Record<string, unknown>).data as Record<string, unknown>[];
            } else if (result.data && Array.isArray(result.data)) {
                dataArray = result.data as Record<string, unknown>[];
            } else {
                // Deep search for array of rate objects
                const found = this.findRateArray(result);
                if (found) dataArray = found;
            }

            for (const row of dataArray) {
                items.push({
                    currency: String(
                        row.currency_id ||
                        row.currency ||
                        row.currencyCode ||
                        row.Currency ||
                        ''
                    ),
                    currencyLabel: String(
                        row.currency_name_eng ||
                        row.currencyName ||
                        row.Currency_Name ||
                        ''
                    ),
                    sellTt: row.selling ||
                        row.sell_tt ||
                        row.Selling ||
                        row.selling_rate,
                    sellNotes: row.selling_note || row.sell_notes || row.bank_note_selling,
                    buyTt: row.buying ||
                        row.buy_tt ||
                        row.Buying ||
                        row.buying_rate,
                    buySight: row.buying_sight || row.buy_sight,
                    buyTransfer: row.buying_transfer || row.buy_transfer,
                    buyNotes: row.buying_note || row.buy_notes || row.bank_note_buying,
                    midRate: row.mid_rate || row.midRate,
                    timestamp: String(row.period || row.date || row.timestamp || ''),
                    raw: row,
                });
            }
        } catch (err) {
            console.error('BOT parse error:', err);
        }

        return items;
    }

    private findRateArray(
        obj: Record<string, unknown>,
        depth = 0
    ): Record<string, unknown>[] | null {
        if (depth > 5) return null;

        for (const val of Object.values(obj)) {
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
                // Check if it looks like rate data
                const first = val[0] as Record<string, unknown>;
                if (
                    first.currency_id ||
                    first.currency ||
                    first.Currency ||
                    first.currencyCode
                ) {
                    return val as Record<string, unknown>[];
                }
            }
            if (typeof val === 'object' && val && !Array.isArray(val)) {
                const found = this.findRateArray(val as Record<string, unknown>, depth + 1);
                if (found) return found;
            }
        }
        return null;
    }

    private parseNumber(val: unknown): number | undefined {
        if (val === null || val === undefined || val === '' || val === '-') {
            return undefined;
        }
        const num = Number(val);
        return isNaN(num) ? undefined : num;
    }
}

interface BotItem {
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
