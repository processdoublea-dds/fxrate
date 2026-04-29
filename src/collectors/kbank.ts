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
    private workflowId: string;

    constructor(workflowId?: string) {
        this.workflowId = workflowId || KBANK_WORKFLOW_ID;
    }

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
            console.log(`KBANK: Triggering BrowserAct workflow (${this.workflowId})...`);

            // 1. Trigger the workflow
            const runRes = await axios.post(`${BROWSERACT_API}/run-task`, {
                workflow_id: this.workflowId
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
                // Mapping:
                //   - "USD 50-100" (or "USD50-100") → mapped to "USD" (Main rate per user request)
                //   - Other denominations (USD 1, USD 5-20) are skipped to avoid duplicates
                let finalCurrency = currencyCode;
                let currencyLabel = currencyCode;

                if (currencyCode.startsWith('USD')) {
                    if (currencyCode === 'USD50-100' || currencyCode === 'USD 50-100') {
                        finalCurrency = 'USD';
                        currencyLabel = 'US Dollar (50-100)';
                    } else if (currencyCode === 'USD' && !seen.has('USD')) {
                        // Plain "USD" without denomination — treat as main USD if not already seen
                        finalCurrency = 'USD';
                        currencyLabel = 'US Dollar';
                    } else {
                        // Skip USD 1, USD 5-20 and other denominations
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

                // Resolve bank datetime — BrowserAct returns varying formats
                // Format 1: "2026-03-31 08:13:30" (ISO-like)
                // Format 2: "31 March 2026 08:13:55" (human-readable)
                const dateTimeStr = item.datetime || item.date_time || item.date || null;
                let bankTimestamp: string | undefined = undefined;
                if (dateTimeStr) {
                    bankTimestamp = parseKbankDateTime(dateTimeStr);
                    if (!bankTimestamp) {
                        console.warn(`KBANK: Could not parse datetime: ${dateTimeStr}`);
                    }
                }

                // Resolve rate fields — KBANK always returns exactly 5 rate fields in fixed order
                // Order: [buy_sight, buy_tt, buy_notes, sell_tt, sell_notes]
                // Field names may vary (bank_* prefix, _rate suffix) but order is ALWAYS consistent
                const metaKeys = new Set([
                    'currency', 'currency_code', 'currency_name', 'currency_pair',
                    'denomination', 'unit', 'unit_range',
                    'date_time', 'datetime', 'date', 'time', 'round'
                ]);
                const rateKeys = Object.keys(item).filter(k =>
                    !metaKeys.has(k.toLowerCase()) &&
                    item[k] !== null &&
                    String(item[k]).trim() !== ''
                );

                let sellTt, sellNotes, buyTt, buySight, buyNotes;

                // Use positional mapping (KBANK always returns 5 rate fields in fixed order)
                if (rateKeys.length >= 5) {
                    buySight = item[rateKeys[0]];  // export_sight_bill_buy_rate / bank_buy_export_sight_bill
                    buyTt = item[rateKeys[1]];     // telex_transfer_buy_rate / bank_buy_telex_transfer
                    buyNotes = item[rateKeys[2]];  // bank_notes_buy_rate / bank_buy_bank_notes
                    sellTt = item[rateKeys[3]];    // tt_draft_cheques_sell_rate / bank_sell_tt_draft_t_cheques
                    sellNotes = item[rateKeys[4]]; // bank_notes_sell_rate / bank_sell_bank_notes
                } else {
                    console.warn(`KBANK: Expected 5 rate fields, got ${rateKeys.length} for ${finalCurrency}. Keys: ${rateKeys.join(', ')}`);
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
 * Parse KBANK datetime string from BrowserAct.
 * Handles multiple formats:
 *   - "2026-03-31 08:13:30" (ISO-like, most common)
 *   - "31 March 2026 08:13:55" (human-readable, sometimes appears)
 *   - "2026-03-31" (date only, fallback to 00:00:00)
 */
function parseKbankDateTime(dateTimeStr: string): string | undefined {
    if (!dateTimeStr) return undefined;

    const trimmed = dateTimeStr.trim();

    // Try Format 1: "2026-03-31 08:13:30" or "2026-03-31"
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        const isoString = trimmed.includes(' ') ? trimmed.replace(' ', 'T') : `${trimmed}T00:00:00`;
        const parsed = new Date(`${isoString}+07:00`);
        if (!isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }

    // Try Format 2: "31 March 2026 08:13:55" or "31 March 2026"
    const monthMap: Record<string, string> = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
        January: '01', February: '02', March: '03', April: '04', June: '06',
        July: '07', August: '08', September: '09', October: '10', November: '11', December: '12'
    };

    const match = trimmed.match(/(\d{1,2})\s+(\w+)\s+(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
    if (match) {
        const [, day, month, year, time] = match;
        const monthNum = monthMap[month] || monthMap[month.substring(0, 3)];
        if (monthNum) {
            const timeStr = time ?? '00:00:00';
            const paddedDay = day.padStart(2, '0');
            const isoString = `${year}-${monthNum}-${paddedDay}T${timeStr}+07:00`;
            const parsed = new Date(isoString);
            if (!isNaN(parsed.getTime())) {
                return parsed.toISOString();
            }
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
