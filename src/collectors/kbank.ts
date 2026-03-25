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
        let rawResponse: any = null;

        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) {
            console.error('KBANK Collector: Missing BROWSERACT_API_KEY environment variable');
            return { rates: [], rateDate, rawResponse: 'Missing API Key' };
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
                return { rates: [], rateDate, rawResponse: runRes.data };
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
                    return { rates: [], rateDate, rawResponse: statusData };
                }

                if (attempts % 5 === 0) {
                    console.log(`KBANK: Still polling BrowserAct task ${taskId} (Status: ${status}, Attempt: ${attempts}/${maxAttempts})`);
                }
            }

            if (!taskResult || !taskResult.output || !taskResult.output.string) {
                console.error('KBANK BrowserAct polling timed out or returned no output');
                rawResponse = taskResult || 'Timed out';
                return { rates: [], rateDate, rawResponse };
            }

            // 3. Parse and map results
            console.log('KBANK: BrowserAct task finished. Parsing data...');
            rawResponse = taskResult.output.string;
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
                if (finalCurrency.length > 10) {
                    console.warn(`KBANK: Skipping currency with code too long (${finalCurrency.length}): ${finalCurrency}`);
                    continue;
                }
                if (seen.has(finalCurrency)) continue;
                seen.add(finalCurrency);

                // Resolve bank datetime — BrowserAct returns varying field names
                // Priority: datetime (most common) → date_time → date+time combo
                const dateTimeStr = item.datetime || item.date_time
                    || (item.date && item.time ? `${item.date} ${item.time}` : null);
                // If no datetime found, leave null so route.ts timestamp filter can reject stale data
                const bankTimestamp = dateTimeStr
                    ? new Date(`${dateTimeStr.replace(' ', 'T')}+07:00`).toISOString()
                    : undefined;

                // Resolve fields using Positional Mapping if exactly 5 rate columns are present
                // (BrowserAct naturally reads table left-to-right, maintaining KBANK website order)
                const metaKeys = new Set(['currency', 'currency_code', 'currency_pair', 'denomination', 'unit', 'unit_range', 'date_time', 'datetime', 'date', 'time', 'round']);
                const rateKeys = Object.keys(item).filter(k => !metaKeys.has(k.toLowerCase()) && item[k] !== null && String(item[k]).trim() !== '');

                let sellTt, sellNotes, buyTt, buySight, buyNotes;

                if (rateKeys.length === 5) {
                    buySight = item[rateKeys[0]];
                    buyTt = item[rateKeys[1]];
                    buyNotes = item[rateKeys[2]];
                    sellTt = item[rateKeys[3]];
                    sellNotes = item[rateKeys[4]];
                } else {
                    console.log(`KBANK: Fallback to fuzzy match for ${finalCurrency} (found ${rateKeys.length} rate keys)`);
                    sellTt = resolveField(item, ['bank_selling_tt_draft_t_cheques', 'bank_selling_telex_transfer', 'tt_draft_t_cheques', 'tt_draft', 'selling_tt']);
                    sellNotes = resolveField(item, ['bank_selling_bank_notes', 'bank_notes_sell', 'bank_notes_selling', 'bank_selling_notes', 'selling_notes']);
                    buyTt = resolveField(item, ['bank_buying_telex_transfer', 'telex_transfer', 'buying_tt', 'tt_buying']);
                    buySight = resolveField(item, ['bank_buying_export_sight_bill', 'export_sight_bill', 'sight_bill', 'export_bill']);
                    buyNotes = resolveField(item, ['bank_buying_bank_notes', 'bank_notes_buy', 'bank_notes_buying', 'bank_buying_notes', 'buying_notes']);
                }

                rates.push({
                    run_id: runId,
                    rate_date: rateDate,
                    source: this.name,
                    currency: finalCurrency,
                    currency_label: currencyLabel,
                    sell_tt: normalizeNumber(sellTt),
                    sell_notes: normalizeNumber(sellNotes),
                    buy_tt: normalizeNumber(buyTt),
                    buy_sight: normalizeNumber(buySight),
                    buy_transfer: 0,
                    buy_notes: normalizeNumber(buyNotes),
                    bank_timestamp: bankTimestamp,
                    raw_data: item,
                });
            }

            console.log(`KBANK/BrowserAct: successfully fetched and mapped ${rates.length} currencies`);

        } catch (err) {
            console.error('KBANK BrowserAct fetch failed:', err);
            return { rates, rateDate, rawResponse: String(err) };
        }

        return { rates, rateDate, rawResponse };
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
 * Resolve a field value from BrowserAct item using known aliases + fuzzy keyword fallback.
 * BrowserAct naming is inconsistent across runs — this handles any variant.
 *
 * Strategy:
 *   1. Try each known alias (exact match)
 *   2. Fuzzy: check if any remaining key contains keywords derived from aliases
 *      e.g. aliases ['bank_notes_sell', ...] → keywords ['sell', 'note']
 */
function resolveField(item: Record<string, any>, aliases: string[]): any {
    // 1. Exact match on known aliases
    for (const alias of aliases) {
        if (item[alias] !== undefined) return item[alias];
    }

    // 2. Fuzzy keyword match — extract keywords from aliases and search item keys
    const skipKeys = new Set(['currency', 'currency_code', 'denomination', 'date_time', 'date', 'time', 'round']);
    const itemKeys = Object.keys(item).filter(k => !skipKeys.has(k));

    // Build keyword set from aliases (split by underscore, take meaningful words)
    const meaningfulWords = new Set<string>();
    for (const alias of aliases) {
        for (const word of alias.split('_')) {
            if (word.length > 2 && !['bank', 'the', 'and'].includes(word)) {
                meaningfulWords.add(word.toLowerCase());
            }
        }
    }

    // Find a key that contains the most keywords
    for (const key of itemKeys) {
        const keyLower = key.toLowerCase();
        const matches = [...meaningfulWords].filter(w => keyLower.includes(w));
        if (matches.length >= 2 || (meaningfulWords.size === 1 && matches.length === 1)) {
            return item[key];
        }
    }

    return undefined;
}

/**
 * Safely parse a number value — BrowserAct may return numbers as strings.
 */
function normalizeNumber(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? 0 : num;
}
