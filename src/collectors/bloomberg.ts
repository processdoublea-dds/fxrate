import axios from 'axios';
import { Collector, CollectorResult, getPreviousBusinessDate, generateRunId } from './base';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * Bloomberg collector — replaced with ExchangeRate-API (open.er-api.com)
 * 
 * Provides mid-market rates for currencies NOT covered by Thai banks:
 * MNT (Mongolian Tugrik), BTN (Bhutanese Ngultrum)
 * 
 * Free API: 1,500 requests/month, no API key needed
 * Returns rates based on THB, we convert to "THB per 1 unit of foreign currency"
 */

const EXCHANGE_RATE_API = 'https://open.er-api.com/v6/latest/THB';

// Currencies Bloomberg is responsible for (not available from Thai banks)
const BLOOMBERG_CURRENCIES: Record<string, string> = {
    MNT: 'Mongolian Tugrik',
    BTN: 'Bhutanese Ngultrum',
};

export class BloombergCollector implements Collector {
    name = 'BLOOMBERG';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getPreviousBusinessDate();

        const rates: ExchangeRateInsert[] = [];

        try {
            const { data } = await axios.get(EXCHANGE_RATE_API, {
                timeout: 10000,
                headers: {
                    Accept: 'application/json',
                },
            });

            if (data.result !== 'success') {
                console.error('ExchangeRate-API error:', data);
                return { rates: [], rateDate };
            }

            const apiRates = data.rates as Record<string, number>;
            const updateTime = data.time_last_update_utc || new Date().toISOString();

            for (const [currency, label] of Object.entries(BLOOMBERG_CURRENCIES)) {
                const rawRate = apiRates[currency];
                if (!rawRate || rawRate === 0) {
                    console.warn(`ExchangeRate-API: ${currency} not found`);
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
                    sell_tt: rate,
                    sell_notes: rate,
                    buy_tt: rate,
                    buy_sight: rate,
                    buy_transfer: rate,
                    buy_notes: rate,
                    bank_timestamp: updateTime,
                    raw_data: {
                        api: 'open.er-api.com',
                        base: 'THB',
                        rawRate,
                        formula: `1 / ${rawRate} = ${thbPerUnit}`,
                    },
                });
            }

            console.log(`Bloomberg/ExchangeRate-API: fetched ${rates.length} currencies`);
        } catch (err) {
            console.error('ExchangeRate-API fetch failed:', err);
        }

        return { rates, rateDate };
    }
}
