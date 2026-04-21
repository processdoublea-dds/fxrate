import { NextResponse } from 'next/server';
import { KbankCollector, generateRunId } from '@/collectors';
import {
    hasRateForToday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams } from '@/lib/teams-notify';
import { getTodayDate } from '@/collectors/base';

// Standalone KBANK endpoint — called by GAS trigger only
// KBANK uses BrowserAct which takes 60-90s, so it gets its own 120s budget
export const maxDuration = 120;
export const dynamic = 'force-dynamic';

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsCount: number;
    durationMs: number;
    errorMessage?: string;
}

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization');
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateDate = getTodayDate();

    // ── TIME GATE: Don't call BrowserAct before 08:00 Bangkok time ──
    const bangkokHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }));
    if (bangkokHour < 8) {
        console.log(`[KBANK] Current Bangkok hour is ${bangkokHour}, skipping (too early, wait until 08:00)`);
        return NextResponse.json({
            success: true,
            summaries: [{
                source: 'KBANK',
                status: 'skipped',
                recordsCount: 0,
                durationMs: 0,
                errorMessage: `Skipped — Bangkok time is before 08:00 (current hour: ${bangkokHour})`,
            }],
            totalNewRates: 0,
        });
    }

    // ── DEDUP: Check if KBANK already fetched AND complete ──
    const EXPECTED_KBANK = 26;
    const alreadyFetched = await hasRateForToday('KBANK', rateDate, undefined, EXPECTED_KBANK);
    if (alreadyFetched) {
        console.log(`[KBANK] Already fetched (complete: 26) for ${rateDate}, skipping`);
        return NextResponse.json({
            success: true,
            summaries: [{
                source: 'KBANK',
                status: 'skipped',
                recordsCount: 0,
                durationMs: 0,
            }],
            totalNewRates: 0,
        });
    }

    // ── Fetch KBANK via BrowserAct (single attempt, ~60-90s) ──
    const collector = new KbankCollector();
    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    let logId: number | null = null;

    try {
        const log = await insertScrapeLog({
            run_id: runId,
            source: collector.name,
            status: 'partial',
            started_at: startedAt,
        });
        logId = log?.id;
    } catch (err) {
        console.error('Failed to create scrape log:', err);
    }

    try {
        console.log(`[KBANK] Starting BrowserAct fetch...`);
        const result = await collector.fetch();
        const durationMs = Date.now() - startMs;

        // Timestamp filter: only accept rates that:
        // 1. Have a valid bank_timestamp (reject if datetime field not resolved — safety net)
        // 2. Have today's date (or newer) — reject stale yesterday data
        // 3. Have a timestamp >= 08:00 Bangkok time — reject early-morning rates (6-7 AM)
        let fetchedRates = result.rates;
        fetchedRates = fetchedRates.filter(r => {
            if (!r.bank_timestamp) return false; // No datetime = reject (don't trust unresolved data)
            const bankTs = new Date(r.bank_timestamp);
            const bankDate = bankTs.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            if (bankDate < result.rateDate) return false;
            // Reject rates published before 08:00 Bangkok time
            const bankHour = Number(bankTs.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }));
            return bankHour >= 8;
        });

        // Minimum record count: KBANK normally returns ~25-30 currencies
        // If significantly fewer, BrowserAct likely scraped incomplete data
        const KBANK_MIN_RECORDS = 10;

        if (fetchedRates.length >= KBANK_MIN_RECORDS) {
            // ✅ Full dataset — save to DB
            await insertRates(fetchedRates);

            if (logId) {
                try {
                    await updateScrapeLog(logId, {
                        status: 'success',
                        completed_at: new Date().toISOString(),
                        records_count: fetchedRates.length,
                        duration_ms: durationMs,
                        raw_response: result.rawResponse,
                    });
                } catch (logErr) {
                    console.error('Failed to update scrape log:', logErr);
                }
            }

            const summary: FetchSummary = {
                source: 'KBANK',
                status: 'success',
                recordsCount: fetchedRates.length,
                durationMs,
            };
            try {
                await notifyTeams([summary], fetchedRates, rateDate);
            } catch (err) {
                console.error('Failed to send Teams notification:', err);
            }

            return NextResponse.json({
                success: true,
                summaries: [summary],
                totalNewRates: fetchedRates.length,
            });
        } else if (fetchedRates.length > 0) {
            // ⚠️ Incomplete dataset — DON'T save, let GAS retry next round
            const msg = `BrowserAct returned only ${fetchedRates.length}/${KBANK_MIN_RECORDS}+ currencies — incomplete, skipping save to allow retry`;
            console.warn(`[KBANK] ${msg}`);

            if (logId) {
                try {
                    await updateScrapeLog(logId, {
                        status: 'skipped',
                        completed_at: new Date().toISOString(),
                        records_count: 0,
                        duration_ms: durationMs,
                        error_message: msg,
                        raw_response: result.rawResponse,
                    });
                } catch (logErr) {
                    console.error('Failed to update scrape log:', logErr);
                }
            }

            return NextResponse.json({
                success: true,
                summaries: [{
                    source: 'KBANK',
                    status: 'skipped',
                    recordsCount: 0,
                    durationMs,
                    errorMessage: msg,
                }],
                totalNewRates: 0,
            });
        } else {
            // BrowserAct succeeded but bank hasn't updated yet (timestamp filter removed all)
            console.warn(`[KBANK] BrowserAct returned ${result.rates.length} rates but 0 passed timestamp filter (bank may not have updated yet)`);

            if (logId) {
                try {
                    await updateScrapeLog(logId, {
                        status: 'skipped',
                        completed_at: new Date().toISOString(),
                        records_count: 0,
                        duration_ms: durationMs,
                        error_message: 'Bank rates not yet updated for today',
                        raw_response: result.rawResponse,
                    });
                } catch (logErr) {
                    console.error('Failed to update scrape log:', logErr);
                }
            }

            return NextResponse.json({
                success: true,
                summaries: [{
                    source: 'KBANK',
                    status: 'skipped',
                    recordsCount: 0,
                    durationMs,
                }],
                totalNewRates: 0,
            });
        }
    } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMessage = `KBANK BrowserAct error: ${err}`;
        console.error(errorMessage);

        if (logId) {
            try {
                await updateScrapeLog(logId, {
                    status: 'failed',
                    completed_at: new Date().toISOString(),
                    error_message: errorMessage,
                    duration_ms: durationMs,
                });
            } catch (logErr) {
                console.error('Failed to update scrape log:', logErr);
            }
        }

        return NextResponse.json({
            success: true,
            summaries: [{
                source: 'KBANK',
                status: 'failed',
                recordsCount: 0,
                durationMs,
                errorMessage,
            }],
            totalNewRates: 0,
        });
    }
}
