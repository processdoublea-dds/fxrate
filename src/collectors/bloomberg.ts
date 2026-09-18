import axios from 'axios';
import { Collector, CollectorResult, getYesterdayDate, generateRunId } from './base';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * Bloomberg Collector (BTN & MNT)
 * 
 * Fetches cross rates for Bhutanese Ngultrum (BTN) and Mongolian Tughrik (MNT).
 * Previously scraped Bloomberg via BrowserAct which frequently timed out or was blocked.
 * Now fetches directly from ExchangeRate API (open.er-api.com with fallback to api.exchangerate-api.com)
 * for instant sub-second response, zero credit cost, and 100% reliability.
 * Results are saved as source="BOT" per user / accounting requirements.
 */

const PRIMARY_API = 'https://open.er-api.com/v6/latest/THB';
const SECONDARY_API = 'https://api.exchangerate-api.com/v4/latest/THB';

export class BloombergCollector implements Collector {
    name = 'BLOOMBERG';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        // BTN/MNT always use yesterday's calendar date (not previous business date)
        const rateDate = getYesterdayDate();
        const rates: ExchangeRateInsert[] = [];

        console.log(`[BLOOMBERG] Fetching BTN and MNT rates for ${rateDate}...`);

        let apiSource = '';
        let btnRateRaw: number | null = null;
        let mntRateRaw: number | null = null;

        // 1. Try Primary API (open.er-api.com)
        try {
            console.log(`[BLOOMBERG] Trying primary API: ${PRIMARY_API}`);
            const res = await axios.get(PRIMARY_API, { timeout: 10000 });
            if (res.status === 200 && res.data?.rates) {
                btnRateRaw = res.data.rates.BTN;
                mntRateRaw = res.data.rates.MNT;
                apiSource = 'open.er-api.com';
            }
        } catch (err: any) {
            console.warn(`[BLOOMBERG] Primary API failed (${err?.message}). Trying secondary API...`);
        }

        // 2. Try Secondary API if primary failed or returned missing data
        if (!btnRateRaw || !mntRateRaw) {
            try {
                console.log(`[BLOOMBERG] Trying secondary API: ${SECONDARY_API}`);
                const res = await axios.get(SECONDARY_API, { timeout: 10000 });
                if (res.status === 200 && res.data?.rates) {
                    btnRateRaw = res.data.rates.BTN;
                    mntRateRaw = res.data.rates.MNT;
                    apiSource = 'api.exchangerate-api.com';
                }
            } catch (err: any) {
                console.error(`[BLOOMBERG] Secondary API failed as well:`, err?.message);
            }
        }

        if (!btnRateRaw || !mntRateRaw) {
            console.error('[BLOOMBERG] Both primary and secondary APIs failed to return BTN/MNT rates.');
            return { rates: [], rateDate, rawResponse: { error: 'Failed to fetch BTN/MNT from exchange rate APIs' } };
        }

        const btnRate = Number((1 / btnRateRaw).toFixed(5));
        const mntRate = Number((1 / mntRateRaw).toFixed(5));

        const buildRate = (currency: string, label: string, finalRate: number, rawRate: number): ExchangeRateInsert => ({
            run_id: runId,
            rate_date: rateDate,
            source: 'BOT', // User explicitly requested BTN/MNT show as BOT source
            currency,
            currency_label: label,
            sell_tt: finalRate,
            sell_notes: finalRate,
            buy_tt: finalRate,
            buy_sight: finalRate,
            buy_transfer: finalRate,
            buy_notes: finalRate,
            bank_timestamp: rateDate + 'T00:00:00.000Z',
            raw_data: {
                api: apiSource,
                base: 'THB',
                rawRatePerThb: rawRate,
                calculatedThbPerUnit: finalRate,
            },
        });

        const btnRow = buildRate('BTN', 'Bhutanese Ngultrum', btnRate, btnRateRaw);
        rates.push(btnRow);

        const mntRow = buildRate('MNT', 'Mongolian Tughrik', mntRate, mntRateRaw);
        rates.push(mntRow);

        console.log(`[BLOOMBERG] Successfully fetched rates via ${apiSource}: BTN=${btnRate}, MNT=${mntRate}`);

        return {
            rates,
            rateDate,
            rawResponse: {
                api: apiSource,
                btnRate,
                mntRate,
                rawBtn: btnRateRaw,
                rawMnt: mntRateRaw,
            },
        };
    }
}
