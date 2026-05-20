import { NextResponse } from 'next/server';
import { KbankCollector } from '@/collectors';
import {
    hasRateForToday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    supabaseAdmin,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams } from '@/lib/teams-notify';
import { getTodayDate } from '@/collectors/base';

/**
 * /api/fetch-kbank — Standalone KBANK endpoint (called by GAS every ~15 min)
 *
 * ── 2-Phase Async Flow ────────────────────────────────────────────────────────
 *
 * The problem: BrowserAct tasks take 90-150s. Vercel budget is 120s.
 * Polling inside one request wastes time + BrowserAct credits when it times out,
 * then GAS retries and fires ANOTHER task — doubling the credit waste.
 *
 * The fix: decouple trigger from result.
 *
 * Phase 1 — TRIGGER  (fast ~2s, runs when no pending task today)
 *   → Fire BrowserAct run-task
 *   → Save task_id to scrape_logs.raw_response = { task_id, triggered_at }
 *   → Return 202 immediately
 *
 * Phase 2 — CHECK  (fast ~2s, runs on every subsequent GAS call while pending)
 *   → Find today's scrape_log with status='partial' and task_id
 *   → Call BrowserAct get-task(task_id)
 *   → If still running  → return 202 'pending'
 *   → If finished       → parse rates, apply timestamp filter, insert to DB
 *   → If failed/stale   → clear pending log, next call will re-trigger
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const maxDuration = 30; // Only needs 30s — no more 90s polling!
export const dynamic = 'force-dynamic';

const EXPECTED_KBANK = 26;
const KBANK_MIN_RECORDS = 10;

// Stale threshold: if task was triggered >30 min ago and still not done, re-trigger
const STALE_TASK_MS = 30 * 60 * 1000;

export async function GET(request: Request) {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateDate = getTodayDate();
    const collector = new KbankCollector();

    // ── Time Gate: Don't call BrowserAct before 08:00 Bangkok time ────────────
    const bangkokHour = Number(new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false,
    }));
    if (bangkokHour < 8) {
        return NextResponse.json({
            success: true,
            phase: 'skipped',
            reason: `Bangkok hour ${bangkokHour} < 08:00`,
        });
    }

    // ── Dedup: Already have full dataset for today? ───────────────────────────
    const alreadyComplete = await hasRateForToday('KBANK', rateDate, undefined, EXPECTED_KBANK);
    if (alreadyComplete) {
        console.log(`[KBANK] Already complete (${EXPECTED_KBANK}) for ${rateDate} — skipping`);
        return NextResponse.json({
            success: true,
            phase: 'skipped',
            reason: `Already have ${EXPECTED_KBANK}+ records for ${rateDate}`,
        });
    }

    // ── Find pending task from a previous Phase 1 call ───────────────────────
    const pendingLog = await getPendingKbankLog(rateDate);

    if (pendingLog) {
        // ── Phase 2: Check existing BrowserAct task ───────────────────────────
        return await handleCheckPhase(pendingLog, collector, rateDate);
    } else {
        // ── Phase 1: Trigger new BrowserAct task ─────────────────────────────
        return await handleTriggerPhase(collector, rateDate);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1: Trigger BrowserAct, save task_id, return immediately
// ─────────────────────────────────────────────────────────────────────────────
async function handleTriggerPhase(
    collector: KbankCollector,
    rateDate: string,
): Promise<NextResponse> {
    let logId: number | null = null;

    try {
        // Create log with status='partial' to mark "pending"
        const log = await insertScrapeLog({
            run_id:     crypto.randomUUID(),
            source:     'KBANK',
            status:     'partial',
            started_at: new Date().toISOString(),
        });
        logId = log?.id ?? null;
    } catch (err) {
        console.error('[KBANK] Failed to create scrape log:', err);
    }

    try {
        const { taskId, triggeredAt } = await collector.triggerTask();

        // Store task_id in raw_response so Phase 2 can find it
        if (logId) {
            await updateScrapeLog(logId, {
                raw_response: { task_id: taskId, triggered_at: triggeredAt },
                error_message: `Waiting for BrowserAct task ${taskId}`,
            });
        }

        console.log(`[KBANK] Phase 1 complete — task triggered: ${taskId}`);
        return NextResponse.json({
            success: true,
            phase: 'triggered',
            task_id: taskId,
            message: 'BrowserAct task started. Next GAS call will check result.',
        });

    } catch (err) {
        const errorMessage = `Phase 1 trigger failed: ${err}`;
        console.error(`[KBANK] ${errorMessage}`);
        if (logId) {
            await updateScrapeLog(logId, {
                status: 'failed',
                completed_at: new Date().toISOString(),
                error_message: errorMessage,
                duration_ms: 0,
            });
        }
        return NextResponse.json({ success: false, phase: 'trigger_failed', error: errorMessage });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2: Check existing BrowserAct task, insert if done
// ─────────────────────────────────────────────────────────────────────────────
async function handleCheckPhase(
    pendingLog: { id: number; task_id: string; triggered_at: string },
    collector: KbankCollector,
    rateDate: string,
): Promise<NextResponse> {
    const { id: logId, task_id: taskId, triggered_at } = pendingLog;

    // Stale check: if task was triggered >30 min ago, give up and re-trigger next call
    const ageMs = Date.now() - new Date(triggered_at).getTime();
    if (ageMs > STALE_TASK_MS) {
        console.warn(`[KBANK] Task ${taskId} is stale (${Math.round(ageMs / 60000)} min). Marking failed — will re-trigger next call.`);
        await updateScrapeLog(logId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: `BrowserAct task ${taskId} stale after ${Math.round(ageMs / 60000)} min`,
        });
        return NextResponse.json({
            success: true,
            phase: 'stale_cleared',
            message: 'Stale task cleared — next call will re-trigger',
        });
    }

    const startMs = Date.now();
    console.log(`[KBANK] Phase 2: Checking task ${taskId} (age: ${Math.round(ageMs / 1000)}s)...`);

    try {
        const result = await collector.checkTask(taskId, rateDate);

        if (result === null) {
            // Still running — come back next GAS round
            console.log(`[KBANK] Task ${taskId} still running — will check again next round`);
            return NextResponse.json({
                success: true,
                phase: 'pending',
                task_id: taskId,
                task_age_seconds: Math.round(ageMs / 1000),
                message: 'BrowserAct task still running. Will check again next round.',
            });
        }

        // Task finished — apply timestamp filter
        const durationMs = Date.now() - startMs;
        let fetchedRates = result.rates.filter(r => {
            if (!r.bank_timestamp) return false;
            const bankTs = new Date(r.bank_timestamp);
            const bankDate = bankTs.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            if (bankDate < rateDate) return false;
            const bankHour = Number(bankTs.toLocaleString('en-US', {
                timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false,
            }));
            return bankHour >= 8;
        });

        if (fetchedRates.length >= KBANK_MIN_RECORDS) {
            // ✅ Good data — insert
            await insertRates(fetchedRates);
            await updateScrapeLog(logId, {
                status: 'success',
                completed_at: new Date().toISOString(),
                records_count: fetchedRates.length,
                duration_ms: durationMs,
                raw_response: { task_id: taskId, triggered_at, result_received: new Date().toISOString() },
                error_message: null,
            });

            const summary = { source: 'KBANK', status: 'success' as const, recordsCount: fetchedRates.length, durationMs };
            try { await notifyTeams([summary], fetchedRates, rateDate); } catch (_) {}

            console.log(`[KBANK] Phase 2 complete — inserted ${fetchedRates.length} records`);
            return NextResponse.json({
                success: true,
                phase: 'completed',
                recordsInserted: fetchedRates.length,
                rateDate,
            });

        } else if (fetchedRates.length > 0) {
            // ⚠️ Incomplete — don't insert, mark skipped so Phase 1 re-triggers
            const msg = `Incomplete: only ${fetchedRates.length}/${KBANK_MIN_RECORDS}+ rates passed filter`;
            console.warn(`[KBANK] ${msg}`);
            await updateScrapeLog(logId, {
                status: 'skipped',
                completed_at: new Date().toISOString(),
                records_count: 0,
                duration_ms: durationMs,
                error_message: msg,
            });
            return NextResponse.json({ success: true, phase: 'incomplete', message: msg });

        } else {
            // ⚠️ 0 rates passed filter (bank not updated yet)
            const msg = `Task ${taskId} finished but 0 rates passed timestamp filter`;
            console.warn(`[KBANK] ${msg}`);
            await updateScrapeLog(logId, {
                status: 'skipped',
                completed_at: new Date().toISOString(),
                records_count: 0,
                duration_ms: durationMs,
                error_message: msg,
            });
            return NextResponse.json({ success: true, phase: 'no_data', message: msg });
        }

    } catch (err) {
        const errorMessage = `Phase 2 check failed for task ${taskId}: ${err}`;
        console.error(`[KBANK] ${errorMessage}`);
        await updateScrapeLog(logId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
        });
        return NextResponse.json({ success: false, phase: 'check_failed', error: errorMessage });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Find today's pending KBANK log (status='partial' with a task_id stored)
// ─────────────────────────────────────────────────────────────────────────────
async function getPendingKbankLog(rateDate: string): Promise<{
    id: number;
    task_id: string;
    triggered_at: string;
} | null> {
    const todayUTC = new Date(rateDate + 'T00:00:00+07:00').toISOString(); // start of Bangkok day in UTC
    const { data, error } = await supabaseAdmin
        .from('scrape_logs')
        .select('id, raw_response, started_at')
        .eq('source', 'KBANK')
        .eq('status', 'partial')
        .gte('started_at', todayUTC)
        .order('started_at', { ascending: false })
        .limit(1)
        .single();

    if (error || !data) return null;

    const raw = data.raw_response as any;
    if (!raw?.task_id) return null;

    return {
        id: data.id,
        task_id: raw.task_id,
        triggered_at: raw.triggered_at ?? data.started_at,
    };
}
