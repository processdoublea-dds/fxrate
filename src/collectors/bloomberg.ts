import axios from 'axios';
import { Collector, CollectorResult, getPreviousBusinessDate, generateRunId } from './base';
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
        const maxAttempts = 30; // 90s max
        while (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            attempts++;

            const statusRes = await axios.get(`${BROWSERACT_API}/get-task?task_id=${taskId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            const statusData = statusRes.data;
            const status = statusData.status;

            if (status === 'finished') {
                const parsed = JSON.parse(statusData.output.string);
                if (parsed && parsed.length > 0 && parsed[0].rate !== undefined) {
                    return Number(parsed[0].rate);
                }
                console.error(`Bloomberg (${label}): Invalid output format`, parsed);
                return null;
            } else if (status === 'failed' || status === 'canceled') {
                console.error(`Bloomberg (${label}): Task failed/canceled`, statusData);
                return null;
            }
        }
        console.error(`Bloomberg (${label}): Task timed out after ${maxAttempts} attempts`);
    } catch (err) {
        console.error(`BrowserAct fetch failed for workflow ${workflowId} (${label}):`, err);
    }
    return null;
}

export class BloombergCollector implements Collector {
    name = 'BLOOMBERG';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getPreviousBusinessDate();
        const rates: ExchangeRateInsert[] = [];

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

        if (!usdThb) {
            console.error('BLOOMBERG: Failed to fetch base USD-THB rate. Aborting calculations.');
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
