import axios from 'axios';
import { Collector, CollectorResult, getYesterdayDate, generateRunId } from './base';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * Bloomberg collector — uses BrowserAct (Headless Browser API)
 * 
 * Fetches USD-THB, USD-BTN, and USD-MNT to calculate the cross rates for
 * Bhutanese Ngultrum (BTN) and Mongolian Tughrik (MNT).
 * Results are saved as source="BOT" per user requirements.
 */

const BROWSERACT_API = 'https://api.browseract.com/v2/workflow';

const WORKFLOWS = {
    USD_THB: '49861960251117646',
    USD_BTN: '49863993941203022',
    USD_MNT: '49863477930660942',
};

async function fetchBrowserAct(workflowId: string, apiKey: string, label: string): Promise<number | null> {
    try {
        const runRes = await axios.post(`${BROWSERACT_API}/run-task`, {
            workflow_id: workflowId
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (runRes.status !== 200 || !runRes.data.id) {
            console.error(`BrowserAct run failed for ${label}:`, runRes.data);
            return null;
        }

        const taskId = runRes.data.id;
        console.log(`Bloomberg (${label}): Task started (ID: ${taskId})`);

        let attempts = 0;
        const maxAttempts = 35; // 105s max (increased from 90s to avoid edge-case timeouts)
        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            attempts++;

            const statusRes = await axios.get(`${BROWSERACT_API}/get-task?task_id=${taskId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            const statusData = statusRes.data;
            const status = statusData.status;

            if (status === 'finished') {
                // Debug: log the raw output structure to diagnose parsing issues
                console.log(`Bloomberg (${label}): Task finished. Output keys: ${JSON.stringify(Object.keys(statusData.output || {}))}`);
                try {
                    const outputStr = statusData.output?.string;
                    if (!outputStr) {
                        console.error(`Bloomberg (${label}): output.string is empty/missing. Full output:`, JSON.stringify(statusData.output).substring(0, 500));
                        return null;
                    }
                    const parsed = JSON.parse(outputStr);
                    if (parsed && parsed.length > 0 && parsed[0].rate !== undefined) {
                        console.log(`Bloomberg (${label}): Rate = ${parsed[0].rate}`);
                        return Number(parsed[0].rate);
                    }
                    console.error(`Bloomberg (${label}): Invalid output format`, JSON.stringify(parsed).substring(0, 500));
                } catch (parseErr) {
                    console.error(`Bloomberg (${label}): JSON parse error:`, parseErr, 'Raw:', JSON.stringify(statusData.output).substring(0, 500));
                }
                return null;
            } else if (status === 'failed' || status === 'canceled') {
                console.error(`Bloomberg (${label}): Task ${status}`, statusData);
                return null;
            }
        }
        console.error(`Bloomberg (${label}): Task timed out after ${maxAttempts * 3}s (${maxAttempts} attempts)`);
    } catch (err) {
        console.error(`BrowserAct fetch failed for workflow ${workflowId} (${label}):`, err);
    }
    return null;
}

export class BloombergCollector implements Collector {
    name = 'BLOOMBERG';

    private async fetchFallbackRates(rateDate: string, runId: string): Promise<ExchangeRateInsert[]> {
        try {
            console.log('BLOOMBERG: Fetching fallback rates from open.er-api.com...');
            const res = await axios.get('https://open.er-api.com/v6/latest/THB');
            if (res.status === 200 && res.data && res.data.rates) {
                const btnRateRaw = res.data.rates.BTN;
                const mntRateRaw = res.data.rates.MNT;

                const btnRate = btnRateRaw ? Number((1 / btnRateRaw).toFixed(5)) : null;
                const mntRate = mntRateRaw ? Number((1 / mntRateRaw).toFixed(5)) : null;

                const rates: ExchangeRateInsert[] = [];

                const buildFallbackRate = (currency: string, label: string, finalRate: number | null): ExchangeRateInsert | null => {
                    if (!finalRate) return null;
                    return {
                        run_id: runId,
                        rate_date: rateDate,
                        source: "BOT",
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
                            api: 'exchangerate-api.com',
                            fallback: true,
                            rawThbPerUnitBtn: btnRateRaw,
                            rawThbPerUnitMnt: mntRateRaw
                        }
                    };
                };

                const btnRow = buildFallbackRate('BTN', 'Bhutanese Ngultrum', btnRate);
                if (btnRow) rates.push(btnRow);

                const mntRow = buildFallbackRate('MNT', 'Mongolian Tughrik', mntRate);
                if (mntRow) rates.push(mntRow);

                console.log(`BLOOMBERG: Fallback rates collected. BTN=${btnRate || 'N/A'}, MNT=${mntRate || 'N/A'}`);
                return rates;
            }
        } catch (err) {
            console.error('BLOOMBERG: Fallback API fetch failed', err);
        }
        return [];
    }

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        // BTN/MNT always use yesterday's calendar date (not previous business date)
        const rateDate = getYesterdayDate();
        let rates: ExchangeRateInsert[] = [];

        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) {
            console.error('BLOOMBERG: Missing BROWSERACT_API_KEY');
            return { rates: [], rateDate };
        }

        console.log('BLOOMBERG: Triggering BrowserAct workflows for USD-THB, USD-BTN, USD-MNT concurrently...');

        // Fetch all 3 workflows concurrently
        const [usdThb, usdBtn, usdMnt] = await Promise.all([
            fetchBrowserAct(WORKFLOWS.USD_THB, apiKey, 'USD-THB'),
            fetchBrowserAct(WORKFLOWS.USD_BTN, apiKey, 'USD-BTN'),
            fetchBrowserAct(WORKFLOWS.USD_MNT, apiKey, 'USD-MNT')
        ]);

        console.log(`BLOOMBERG Rates fetched: USD-THB=${usdThb}, USD-BTN=${usdBtn}, USD-MNT=${usdMnt}`);

        // If any of the required rates failed, trigger the fallback mechanism
        if (!usdThb || !usdBtn || !usdMnt) {
            console.warn('BLOOMBERG: Missing some rates from BrowserAct. Falling back to open.er-api.com...');
            const fallbackRates = await this.fetchFallbackRates(rateDate, runId);
            if (fallbackRates.length > 0) {
                return { rates: fallbackRates, rateDate };
            }
        }

        if (!usdThb) {
            console.error('BLOOMBERG: Failed to fetch base USD-THB rate and fallback completely failed. Aborting calculations.');
            return { rates: [], rateDate };
        }

        const buildRate = (currency: string, label: string, crossRate: number | null): ExchangeRateInsert | null => {
            if (!crossRate) return null;

            // e.g. BTN = USDTHB / USDBTN
            const finalRate = Number((usdThb / crossRate).toFixed(5));

            return {
                run_id: runId,
                rate_date: rateDate,
                source: "BOT", // User explicitly requested these rows show as BOT source
                currency,
                currency_label: label,
                // Apply to all fields as mid-market estimates
                sell_tt: finalRate,
                sell_notes: finalRate,
                buy_tt: finalRate,
                buy_sight: finalRate,
                buy_transfer: finalRate,
                buy_notes: finalRate,
                // Match the BOT timestamp format
                bank_timestamp: rateDate + 'T00:00:00.000Z',
                raw_data: {
                    api: 'browseract',
                    base: 'USD',
                    usdThb,
                    usdCross: crossRate,
                    formula: `${usdThb} / ${crossRate} = ${finalRate}`
                }
            };
        };

        const btnRow = buildRate('BTN', 'Bhutanese Ngultrum', usdBtn);
        if (btnRow) rates.push(btnRow);

        const mntRow = buildRate('MNT', 'Mongolian Tughrik', usdMnt);
        if (mntRow) rates.push(mntRow);

        console.log(`BLOOMBERG: Cross rates calculations complete. BTN=${btnRow?.sell_tt || 'N/A'}, MNT=${mntRow?.sell_tt || 'N/A'}`);

        return { rates, rateDate };
    }
}
