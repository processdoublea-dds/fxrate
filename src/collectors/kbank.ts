import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * KBANK collector — delegates to Supabase Edge Function
 * 
 * kasikornbank.com uses Akamai CDN which blocks server-side requests.
 * We use a Supabase Edge Function (150s timeout) to call Browserless.io,
 * scrape the page, and insert data directly into the database.
 * 
 * The Vercel API just proxies the request to the edge function.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';

export class KbankCollector implements Collector {
    name = 'KBANK';

    async fetch(): Promise<CollectorResult> {
        const rateDate = getTodayDate();

        if (!BROWSERLESS_API_KEY) {
            console.error('KBANK: BROWSERLESS_API_KEY not set');
            return { rates: [], rateDate };
        }

        try {
            // Call Supabase Edge Function
            const edgeFnUrl = `${SUPABASE_URL}/functions/v1/fetch-kbank`;

            const { data } = await axios.post(
                edgeFnUrl,
                { browserlessKey: BROWSERLESS_API_KEY },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                    },
                    timeout: 120000, // 2 min timeout for the edge function
                }
            );

            console.log('KBANK edge function result:', JSON.stringify(data));

            if (data.success) {
                // Edge function already inserted data into DB
                // Return a fake rates array with the count for the API response
                const fakeRates: ExchangeRateInsert[] = [];
                const currencies = data.currencies || [];

                for (const currency of currencies) {
                    fakeRates.push({
                        run_id: generateRunId(),
                        rate_date: rateDate,
                        source: this.name,
                        currency,
                        currency_label: currency,
                        bank_timestamp: new Date().toISOString(),
                    });
                }

                return {
                    rates: [], // Empty — data already inserted by edge function
                    rateDate,
                    bankTimestamp: new Date().toISOString(),
                };
            } else {
                console.error('KBANK edge function error:', data.error);
                return { rates: [], rateDate };
            }
        } catch (err) {
            console.error('KBANK fetch failed:', err instanceof Error ? err.message : err);
            return { rates: [], rateDate };
        }
    }
}
