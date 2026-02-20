import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * KBANK collector — uses BrowserAct (Headless Browser API)
 * 
 * kasikornbank.com is protected by Akamai CDN which blocks ALL server-side requests.
 * We use BrowserAct to spawn a real browser, navigate to the site, and extract the rates.
 */

const BROWSERACT_API = 'https://api.browseract.com/v2/workflow';

// The workflow ID configured in BrowserAct for Kasikorn Bank
const KBANK_WORKFLOW_ID = '80827033896840284';

export class KbankCollector implements Collector {
    name = 'KBANK';

    async fetch(): Promise<CollectorResult> {
        const runId = generateRunId();
        const rateDate = getTodayDate();
        const rates: ExchangeRateInsert[] = [];

        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) {
            console.error('KBANK Collector: Missing BROWSERACT_API_KEY environment variable');
            return { rates: [], rateDate };
        }

        try {
            console.log('KBANK: Triggering BrowserAct workflow...');

            // 1. Trigger the workflow
            const runRes = await axios.post(`${BROWSERACT_API}/run-task`, {
                workflow_id: KBANK_WORKFLOW_ID
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (runRes.status !== 200 || !runRes.data.id) {
                console.error('KBANK BrowserAct run failed:', runRes.data);
                return { rates: [], rateDate };
            }

            const taskId = runRes.data.id;
            console.log(`KBANK: BrowserAct task started (ID: ${taskId}). Polling for results...`);

            // 2. Poll for results
            let taskResult: any = null;
            let attempts = 0;
            const maxAttempts = 30; // 30 * 3s = 90s max wait time

            while (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                attempts++;

                const statusRes = await axios.get(`${BROWSERACT_API}/get-task?task_id=${taskId}`, {
                    headers: { 'Authorization': `Bearer ${apiKey}` }
                });

                const statusData = statusRes.data;
                const status = statusData.status;

                if (status === 'finished') {
                    taskResult = statusData;
                    break;
                } else if (status === 'failed' || status === 'canceled') {
                    console.error('KBANK BrowserAct task failed or canceled:', statusData);
                    return { rates: [], rateDate };
                }

                if (attempts % 5 === 0) {
                    console.log(`KBANK: Still polling BrowserAct task ${taskId} (Status: ${status}, Attempt: ${attempts}/${maxAttempts})`);
                }
            }

            if (!taskResult || !taskResult.output || !taskResult.output.string) {
                console.error('KBANK BrowserAct polling timed out or returned no output');
                return { rates: [], rateDate };
            }

            // 3. Parse and map results
            console.log('KBANK: BrowserAct task finished. Parsing data...');
            const parsedData = JSON.parse(taskResult.output.string);
            const seen = new Set<string>();

            for (const item of parsedData) {
                let currencyCode = item.currency_code.toUpperCase();

                // Handle Kbank Denominations
                // Typically USD1, USD5-20, USD50-100
                let finalCurrency = currencyCode;
                let currencyLabel = currencyCode;

                if (currencyCode.includes('USD')) {
                    if (currencyCode === 'USD1') {
                        finalCurrency = 'USD'; // Map $1-2 to main USD record (User Preference)
                        currencyLabel = 'US Dollar $1-2';
                    } else if (currencyCode === 'USD5-20') {
                        finalCurrency = 'USD2';
                        currencyLabel = 'US Dollar $5-20';
                    } else if (currencyCode === 'USD50-100') {
                        finalCurrency = 'USD3';
                        currencyLabel = 'US Dollar $50-100';
                    }
                }

                if (!shouldIncludeCurrency(this.name, finalCurrency)) continue;
                if (seen.has(finalCurrency)) continue;
                seen.add(finalCurrency);

                const bankTimestamp = item.date_time
                    ? new Date(`${item.date_time.replace(' ', 'T')}+07:00`).toISOString()
                    : new Date().toISOString();

                rates.push({
                    run_id: runId,
                    rate_date: rateDate,
                    source: this.name,
                    currency: finalCurrency,
                    currency_label: currencyLabel,
                    sell_tt: item.tt_draft_t_cheques || 0, // KBANK uses this column for Selling TT
                    sell_notes: item.bank_selling_notes || 0,
                    buy_tt: item.telex_transfer || 0, // KBANK uses this column for Buying TT
                    buy_sight: item.export_sight_bill || 0,
                    buy_transfer: 0,
                    buy_notes: item.bank_buying_notes || 0,
                    bank_timestamp: bankTimestamp,
                    raw_data: item,
                });
            }

            console.log(`KBANK/BrowserAct: successfully fetched and mapped ${rates.length} currencies`);

        } catch (err) {
            console.error('KBANK BrowserAct fetch failed:', err);
        }

        return { rates, rateDate };
    }
}
