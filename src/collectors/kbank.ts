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
            console.log(`KBANK: Received ${parsedData.length} items. Sample keys: ${parsedData.length > 0 ? Object.keys(parsedData[0]).join(', ') : 'N/A'}`);
            const seen = new Set<string>();

            for (const item of parsedData) {
                // --- Normalize currency code ---
                // BrowserAct returns inconsistent formats:
                //   Format A: { "currency": "USD 1" }           — denomination appended
                //   Format B: { "currency": "USD", "denomination": "1" }  — separated
                //   Format C: { "currency_code": "USD1" }       — legacy (if ever)
                const currencyCode = normalizeCurrencyCode(item);
                if (!currencyCode) {
                    console.warn('KBANK: Skipping item — cannot resolve currency:', JSON.stringify(item).slice(0, 200));
                    continue;
                }

                // Handle Kbank USD Denominations
                // Only keep "USD 1" (or "USD1") → mapped to "USD"
                // Skip other denominations (USD 5-20, USD 50-100) per business rules
                let finalCurrency = currencyCode;
                let currencyLabel = currencyCode;

                if (currencyCode.startsWith('USD')) {
                    if (currencyCode === 'USD1' || currencyCode === 'USD 1') {
                        finalCurrency = 'USD';
                        currencyLabel = 'US Dollar';
                    } else if (currencyCode === 'USD') {
                        // Plain "USD" without denomination — treat as main USD
                        finalCurrency = 'USD';
                        currencyLabel = 'US Dollar';
                    } else {
                        // Skip USD 5-20, USD 50-100, and any other USD denominations
                        continue;
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
                    sell_tt: normalizeNumber(item.tt_draft_t_cheques),
                    sell_notes: normalizeNumber(item.bank_selling_notes),
                    buy_tt: normalizeNumber(item.telex_transfer),
                    buy_sight: normalizeNumber(item.export_sight_bill),
                    buy_transfer: 0,
                    buy_notes: normalizeNumber(item.bank_buying_notes),
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

/**
 * Normalize the currency code from BrowserAct response.
 * Handles multiple formats:
 *   - { currency: "USD 1" }              → "USD1"
 *   - { currency: "USD", denomination: "1" } → "USD1"
 *   - { currency: "EUR" }                → "EUR"
 *   - { currency_code: "USD1" }          → "USD1" (legacy fallback)
 */
function normalizeCurrencyCode(item: Record<string, any>): string | null {
    const rawCurrency = (item.currency_code || item.currency || '').toString().trim().toUpperCase();
    if (!rawCurrency) return null;

    const denomination = (item.denomination || '').toString().trim();

    // If denomination exists as a separate field, combine them
    // e.g. currency="USD" + denomination="1" → "USD1"
    if (denomination) {
        return `${rawCurrency}${denomination}`;
    }

    // If currency already contains denomination (e.g. "USD 1"), normalize spaces
    // "USD 1" → "USD1", "USD 5-20" → "USD5-20"
    return rawCurrency.replace(/\s+/g, '');
}

/**
 * Safely parse a number value — BrowserAct may return numbers as strings.
 */
function normalizeNumber(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? 0 : num;
}
