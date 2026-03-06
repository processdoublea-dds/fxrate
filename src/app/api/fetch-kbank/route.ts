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

    // ── DEDUP: Check if KBANK already fetched ──
    const alreadyFetched = await hasRateForToday('KBANK', rateDate);
    if (alreadyFetched) {
        console.log(`[KBANK] Already fetched for ${rateDate}, skipping`);
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

        // Timestamp filter: only accept rates with today's date
        let fetchedRates = result.rates;
        fetchedRates = fetchedRates.filter(r => {
            if (!r.bank_timestamp) return true;
            const bankDate = new Date(r.bank_timestamp)
                .toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
            return bankDate >= result.rateDate;
        });

        if (fetchedRates.length > 0) {
            await insertRates(fetchedRates);

            if (logId) {
                try {
                    await updateScrapeLog(logId, {
                        status: 'success',
                        completed_at: new Date().toISOString(),
                        records_count: fetchedRates.length,
                        duration_ms: durationMs,
                    });
                } catch (logErr) {
                    console.error('Failed to update scrape log:', logErr);
                }
            }

            // Notify Teams
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
