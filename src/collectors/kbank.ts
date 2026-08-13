import axios from 'axios';
import { Collector, CollectorResult, getTodayDate, generateRunId } from './base';
import { shouldIncludeCurrency } from '../lib/currency-config';
import { ExchangeRateInsert } from '../lib/supabase';

/**
 * KBANK collector — uses BrowserAct (Headless Browser API)
 *
 * kasikornbank.com is protected by Akamai CDN which blocks ALL server-side requests.
 * We use BrowserAct to spawn a real browser, navigate to the site, and extract the rates.
 *
 * ── 2-Phase Async Design ──────────────────────────────────────────────────────
 * BrowserAct tasks take 90-120s. Vercel budget is 120s.
 * Polling inside the same request wastes budget AND BrowserAct credits on timeout.
 *
 * Phase 1 (trigger): Fire BrowserAct → get task_id → return immediately (~2s)
 * Phase 2 (check):   Next GAS round → check task_id → if done, parse & insert
 *
 * task_id is persisted in scrape_logs.raw_response as { task_id, triggered_at }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BROWSERACT_API = 'https://api.browseract.com/v2/workflow';
const KBANK_WORKFLOW_ID = '80827033896840284';

export interface KbankTriggerResult {
    taskId: string;
    triggeredAt: string;
}

export class KbankCollector implements Collector {
    name = 'KBANK';
    private workflowId: string;

    constructor(workflowId?: string) {
        this.workflowId = workflowId || KBANK_WORKFLOW_ID;
    }

    // ── Phase 1: Trigger BrowserAct task, return task_id immediately ──────────
    async triggerTask(): Promise<KbankTriggerResult> {
        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) throw new Error('Missing BROWSERACT_API_KEY');

        console.log(`[KBANK] Phase 1: Triggering BrowserAct workflow ${this.workflowId}...`);

        const runRes = await axios.post(`${BROWSERACT_API}/run-task`, {
            workflow_id: this.workflowId,
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: 15000, // 15s — just for the trigger call
        });

        if (runRes.status !== 200 || !runRes.data.id) {
            throw new Error(`BrowserAct run-task failed: ${JSON.stringify(runRes.data)}`);
        }

        const taskId = runRes.data.id;
        console.log(`[KBANK] Phase 1 done — task_id: ${taskId}`);
        return { taskId, triggeredAt: new Date().toISOString() };
    }

    // ── Phase 2: Check existing task result, return null if still running ─────
    async checkTask(taskId: string, rateDate: string): Promise<CollectorResult | null> {
        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) throw new Error('Missing BROWSERACT_API_KEY');

        console.log(`[KBANK] Phase 2: Checking task ${taskId}...`);

        const statusRes = await axios.get(`${BROWSERACT_API}/get-task?task_id=${taskId}`, {
            headers: { 'Authorization': `Bearer ${apiKey}` },
            timeout: 10000,
        });

        const statusData = statusRes.data;
        const status = statusData.status;
        console.log(`[KBANK] Task ${taskId} status: ${status}`);

        if (status === 'failed' || status === 'canceled') {
            throw new Error(`BrowserAct task ${taskId} ended with: ${status}`);
        }

        if (status !== 'finished') {
            // Still running — caller will retry next GAS round
            return null;
        }

        if (!statusData.output?.string) {
            throw new Error(`BrowserAct task ${taskId} finished but output is empty`);
        }

        // Parse and map results
        const rawResponse = statusData.output.string;
        const parsedData: Record<string, any>[] = JSON.parse(rawResponse);
        console.log(`[KBANK] Task ${taskId} returned ${parsedData.length} items`);

        const rates = this.parseRates(parsedData, rateDate);
        return { rates, rateDate, rawResponse };
    }

    // ── Legacy: fetch() = trigger + poll (kept for fetch-all-sources compat) ───
    // ⚠️  Avoid using this directly — prefer triggerTask() + checkTask() instead.
    async fetch(): Promise<CollectorResult> {
        const rateDate = getTodayDate();
        const apiKey = process.env.BROWSERACT_API_KEY;
        if (!apiKey) {
            console.error('KBANK Collector: Missing BROWSERACT_API_KEY');
            return { rates: [], rateDate, rawResponse: 'Missing API Key' };
        }

        try {
            const { taskId } = await this.triggerTask();

            // Reduced polling: 25 × 3s = 75s (leaves ~45s buffer in 120s Vercel budget)
            let taskResult: any = null;
            for (let attempt = 0; attempt < 25; attempt++) {
                await new Promise(r => setTimeout(r, 3000));
                const result = await this.checkTask(taskId, rateDate);
                if (result !== null) {
                    return result; // done
                }
                if (attempt % 5 === 0 && attempt > 0) {
                    console.log(`[KBANK] Still waiting for task ${taskId} (attempt ${attempt}/25)`);
                }
            }

            console.error(`[KBANK] fetch() polling timed out for task ${taskId}`);
            return { rates: [], rateDate, rawResponse: `Timed out waiting for task ${taskId}` };

        } catch (err) {
            console.error('[KBANK] fetch() failed:', err);
            return { rates: [], rateDate, rawResponse: String(err) };
        }
    }

    // ── Internal: parse raw BrowserAct JSON into ExchangeRateInsert[] ─────────
    parseRates(parsedData: Record<string, any>[], rateDate: string): ExchangeRateInsert[] {
        const runId = generateRunId();
        const rates: ExchangeRateInsert[] = [];
        const seen = new Set<string>();

        for (const item of parsedData) {
            const currencyCode = normalizeCurrencyCode(item);
            if (!currencyCode) {
                console.warn('KBANK: Skipping item — cannot resolve currency:', JSON.stringify(item).slice(0, 200));
                continue;
            }

            // USD denomination handling
            let finalCurrency = currencyCode;
            let currencyLabel = currencyCode;

            if (currencyCode.startsWith('USD')) {
                if (currencyCode.includes('50-100')) {
                    finalCurrency = 'USD';
                    currencyLabel = 'US Dollar (50-100)';
                } else if (currencyCode === 'USD' && !seen.has('USD')) {
                    finalCurrency = 'USD';
                    currencyLabel = 'US Dollar';
                } else {
                    continue; // Skip USD 1, USD 5-20
                }
            }

            if (!shouldIncludeCurrency(this.name, finalCurrency)) continue;
            if (finalCurrency.length > 10) {
                console.warn(`KBANK: Skipping long currency code: ${finalCurrency}`);
                continue;
            }
            if (seen.has(finalCurrency)) continue;
            seen.add(finalCurrency);

            // Parse bank datetime
            const dateTimeStr = item.datetime || item.date_time || item.date || null;
            let bankTimestamp: string | undefined;
            if (dateTimeStr) {
                bankTimestamp = parseKbankDateTime(dateTimeStr);
                if (!bankTimestamp) console.warn(`KBANK: Could not parse datetime: ${dateTimeStr}`);
            }

            // Rate field positional mapping (always 5 fields: buy_sight, buy_tt, buy_notes, sell_tt, sell_notes)
            const metaKeys = new Set([
                'currency', 'currency_code', 'currency_name', 'currency_pair',
                'denomination', 'unit', 'unit_range', 'usd_range', 'usd_category', 'category',
                'date_time', 'datetime', 'date', 'time', 'round',
            ]);
            const rateKeys = Object.keys(item).filter(k =>
                !metaKeys.has(k.toLowerCase()) &&
                item[k] !== null &&
                String(item[k]).trim() !== ''
            );

            let buySight, buyTt, buyNotes, sellTt, sellNotes;
            if (rateKeys.length >= 5) {
                buySight  = item[rateKeys[0]];
                buyTt     = item[rateKeys[1]];
                buyNotes  = item[rateKeys[2]];
                sellTt    = item[rateKeys[3]];
                sellNotes = item[rateKeys[4]];
            } else {
                console.warn(`KBANK: Expected 5 rate fields, got ${rateKeys.length} for ${finalCurrency}`);
            }

            rates.push({
                run_id:         runId,
                rate_date:      rateDate,
                source:         this.name,
                currency:       finalCurrency,
                currency_label: currencyLabel,
                sell_tt:        normalizeNumber(sellTt),
                sell_notes:     normalizeNumber(sellNotes),
                buy_tt:         normalizeNumber(buyTt),
                buy_sight:      normalizeNumber(buySight),
                buy_transfer:   0,
                buy_notes:      normalizeNumber(buyNotes),
                bank_timestamp: bankTimestamp,
                raw_data:       item,
            });
        }

        console.log(`[KBANK] Mapped ${rates.length} currencies from ${parsedData.length} raw items`);
        return rates;
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalizeCurrencyCode(item: Record<string, any>): string | null {
    const rawCurrency = (item.currency_code || item.currency || '').toString().trim().toUpperCase();
    if (!rawCurrency) return null;
    const denomination = (item.denomination || item.usd_range || item.usd_category || item.category || '').toString().trim();
    if (denomination) {
        if (denomination.toUpperCase().startsWith(rawCurrency)) {
            return denomination.replace(/\s+/g, '');
        }
        return `${rawCurrency}${denomination}`.replace(/\s+/g, '');
    }
    return rawCurrency.replace(/\s+/g, '');
}

function parseKbankDateTime(dateTimeStr: string): string | undefined {
    if (!dateTimeStr) return undefined;
    const trimmed = dateTimeStr.trim();

    // Format 1: "2026-08-13T08:30:05", "2026-08-13 08:30:05", or "2026-08-13"
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
        let isoString = trimmed;
        if (trimmed.includes(' ')) {
            isoString = trimmed.replace(' ', 'T');
        }
        if (!isoString.includes('T')) {
            isoString = `${isoString}T00:00:00`;
        }
        const targetString = isoString.endsWith('Z') || isoString.includes('+') ? isoString : `${isoString}+07:00`;
        const parsed = new Date(targetString);
        if (!isNaN(parsed.getTime())) return parsed.toISOString();
    }

    // Format 2: "31 March 2026 08:13:55"
    const monthMap: Record<string, string> = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
        January: '01', February: '02', March: '03', April: '04', June: '06',
        July: '07', August: '08', September: '09', October: '10', November: '11', December: '12',
    };
    const match = trimmed.match(/(\d{1,2})\s+(\w+)\s+(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
    if (match) {
        const [, day, month, year, time] = match;
        const monthNum = monthMap[month] || monthMap[month.substring(0, 3)];
        if (monthNum) {
            const isoString = `${year}-${monthNum}-${day.padStart(2, '0')}T${time ?? '00:00:00'}+07:00`;
            const parsed = new Date(isoString);
            if (!isNaN(parsed.getTime())) return parsed.toISOString();
        }
    }
    return undefined;
}

function normalizeNumber(value: any): number {
    if (value === null || value === undefined || value === '') return 0;
    const num = typeof value === 'string' ? parseFloat(value) : Number(value);
    return isNaN(num) ? 0 : num;
}
