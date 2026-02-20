import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

// KTB Remix loader endpoint — returns JSON directly
const KTB_URL =
    'https://exchangerate.krungthai.com/counter-rate?_data=routes%2Fcounter-rate';

/**
 * KTB JSON fields mapping:
 *   currencyCode   → currency
 *   currencyName   → currency_label
 *   sellingRate     → sell_tt
 *   bnSellingRate   → sell_notes
 *   ttRate          → buy_tt
 *   sightBillRate   → buy_sight
 *   bnBuyingRate    → buy_notes
 *   denomRate       → used to filter duplicates (e.g. "$1-2", "$50-100")
 *   exType          → "1" = main rate, "2","3" = denomination variants
 */
export class KtbCollector implements Collector {
    name = 'KTB';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const { data } = await axios.get(KTB_URL, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: 'application/json',
            },
            timeout: 30000,
        });

        const rates: ExchangeRateInsert[] = [];
        const items: KtbRate[] = data.itemList || [];
        const bankDate = data.date || '';
        const bankTimestamp = this.parseTimestamp(bankDate);

        // Process items — handle denominations
        const seen = new Set<string>();

        for (const item of items) {
            const baseCurrency = (item.currencyCode || '').toUpperCase();
            if (!baseCurrency) continue;

            let finalCurrency = baseCurrency;

            // User preference: $1-2 should be recorded as the main currency rate.
            // Other denominations are stored as variants.
            if (item.denomRate) {
                if (item.denomRate.includes('1-2') || item.denomRate.includes('$1')) {
                    finalCurrency = baseCurrency; // $1-2 becomes MAIN
                } else if (item.denomRate.includes('5-20') || item.denomRate.includes('$5')) {
                    finalCurrency = `${baseCurrency}2`;
                } else if (item.denomRate.includes('50-100') || item.denomRate.includes('$50-') || item.denomRate.includes('$50')) {
                    finalCurrency = `${baseCurrency}3`;
                } else {
                    finalCurrency = `${baseCurrency}_OTH`;
                }
            } else if (item.exType !== '1') {
                // Ignore unknown variants without denom strings
                continue;
            }

            if (!shouldIncludeCurrency(this.name, finalCurrency)) continue;
            if (seen.has(finalCurrency)) continue;
            seen.add(finalCurrency);

            rates.push(this.buildRate(runId, rateDate, finalCurrency, item, bankTimestamp));
        }

        return { rates, rateDate };
    }

    private buildRate(
        runId: string,
        rateDate: string,
        currency: string,
        item: KtbRate,
        bankTimestamp: string
    ): ExchangeRateInsert {
        return {
            run_id: runId,
            rate_date: rateDate,
            source: this.name,
            currency,
            currency_label: `${item.currencyName}${item.denomRate ? ' ' + item.denomRate : ''}`,
            sell_tt: this.parseNumber(item.sellingRate),
            sell_notes: this.parseNumber(item.bnSellingRate),
            buy_tt: this.parseNumber(item.ttRate),
            buy_sight: this.parseNumber(item.sightBillRate),
            buy_notes: this.parseNumber(item.bnBuyingRate),
            bank_timestamp: bankTimestamp,
            raw_data: item as unknown as Record<string, unknown>,
        };
    }

    private parseTimestamp(dateStr: string): string {
        // "19/02/2026 13:32" → ISO
        try {
            const [datePart, timePart] = dateStr.split(' ');
            const [day, month, year] = datePart.split('/');
            return new Date(`${year}-${month}-${day}T${timePart}:00+07:00`).toISOString();
        } catch {
            return new Date().toISOString();
        }
    }

    private parseNumber(val: unknown): number | undefined {
        if (val === null || val === undefined || val === '' || val === '-' || val === 'Unq') {
            return undefined;
        }
        const str = String(val).replace(/,/g, '');
        const num = Number(str);
        return isNaN(num) ? undefined : num;
    }
}

interface KtbRate {
    currencyCode: string;
    currencyName: string;
    denomRate?: string;
    exType: string;
    sellingRate: string;
    bnSellingRate: string;
    ttRate: string;
    sightBillRate: string;
    bnBuyingRate: string;
    exDate: string;
    round: string;
    time: string;
    key: string;
}
