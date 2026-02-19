import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * KBANK collector — uses ExchangeRate-API (open.er-api.com) as data source
 * 
 * kasikornbank.com is protected by Akamai CDN which blocks ALL server-side
 * requests (direct, Browserless.io headless browser, etc). Using free
 * ExchangeRate-API as a reliable alternative for mid-market rates.
 * 
 * Note: These are mid-market rates, not KBANK-specific buy/sell rates.
 * The data serves as a reference for currencies KBANK would normally publish.
 */

const EXCHANGE_RATE_API = 'https://open.er-api.com/v6/latest/THB';

// All currencies KBANK typically publishes (minus excluded ones per currency-config)
const KBANK_CURRENCIES: Record<string, string> = {
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'British Pound',
    JPY: 'Japanese Yen',
    CNY: 'Chinese Yuan',
    AUD: 'Australian Dollar',
    SGD: 'Singapore Dollar',
    CHF: 'Swiss Franc',
    HKD: 'Hong Kong Dollar',
    CAD: 'Canadian Dollar',
    NZD: 'New Zealand Dollar',
    SEK: 'Swedish Krona',
    NOK: 'Norwegian Krone',
    DKK: 'Danish Krone',
    KRW: 'Korean Won',
    TWD: 'Taiwan Dollar',
    INR: 'Indian Rupee',
    MYR: 'Malaysian Ringgit',
    IDR: 'Indonesian Rupiah',
    PHP: 'Philippine Peso',
    VND: 'Vietnamese Dong',
    AED: 'UAE Dirham',
    SAR: 'Saudi Riyal',
    BHD: 'Bahraini Dinar',
    OMR: 'Omani Rial',
    KWD: 'Kuwaiti Dinar',
    BND: 'Brunei Dollar',
    ZAR: 'South African Rand',
    MXN: 'Mexican Peso',
};

export class KbankCollector implements Collector {
    name = 'KBANK';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();

        const rates: ExchangeRateInsert[] = [];

        try {
            const { data } = await axios.get(EXCHANGE_RATE_API, {
                timeout: 10000,
                headers: { Accept: 'application/json' },
            });

            if (data.result !== 'success') {
                console.error('ExchangeRate-API error for KBANK:', data);
                return { rates: [], rateDate };
            }

            const apiRates = data.rates as Record<string, number>;
            const updateTime = data.time_last_update_utc || new Date().toISOString();

            for (const [currency, label] of Object.entries(KBANK_CURRENCIES)) {
                if (!shouldIncludeCurrency(this.name, currency)) continue;

                const rawRate = apiRates[currency];
                if (!rawRate || rawRate === 0) {
                    console.warn(`ExchangeRate-API: ${currency} not found for KBANK`);
                    continue;
                }

                // API returns "how many units of X per 1 THB"
                // We want "how many THB per 1 unit of X"
                const thbPerUnit = 1 / rawRate;

                const rate = Number(thbPerUnit.toFixed(5));

                rates.push({
                    run_id: runId,
                    rate_date: rateDate,
                    source: this.name,
                    currency,
                    currency_label: label,
                    mid_rate: Number(thbPerUnit.toFixed(6)),
                    // Fill all sell fields with the same rate
                    sell_tt: rate,
                    sell_notes: rate,
                    // Fill all buy fields with the same rate
                    buy_tt: rate,
                    buy_sight: rate,
                    buy_transfer: rate,
                    buy_notes: rate,
                    bank_timestamp: updateTime,
                    raw_data: {
                        api: 'open.er-api.com',
                        base: 'THB',
                        rawRate,
                        note: 'Mid-market rate from ExchangeRate-API (KBANK site blocked by Akamai)',
                    },
                });
            }

            console.log(`KBANK/ExchangeRate-API: fetched ${rates.length} currencies`);
        } catch (err) {
            console.error('KBANK ExchangeRate-API fetch failed:', err);
        }

        return { rates, rateDate };
    }
}
