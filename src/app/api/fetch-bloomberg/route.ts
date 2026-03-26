import { NextResponse } from 'next/server';
import { BloombergCollector, generateRunId } from '@/collectors';
import {
    hasRateForToday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams, notifyTeamsError } from '@/lib/teams-notify';
import { getYesterdayDate } from '@/collectors/base';

// Vercel Cron: 30 1 * * 1-5 (UTC 01:30 Mon-Fri = Thailand 08:30)
export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsCount: number;
    durationMs: number;
    errorMessage?: string;
}

export async function GET(request: Request) {
    // Verify cron secret in production
    const authHeader = request.headers.get('authorization');
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const summaries: FetchSummary[] = [];
    const allRates: ExchangeRateInsert[] = [];
    let newDataFetched = false;

    // Bloomberg always uses yesterday's calendar date (not previous business date)
    // On Monday → Sunday, on Tuesday → Monday, etc.
    const rateDate = getYesterdayDate();

    // ── DEDUP: Check if BTN + MNT already exist ──
    // Bloomberg saves BTN/MNT with source="BOT". If both exist, skip BrowserAct entirely.
    // This prevents calling BrowserAct 3 workflows on every GAS round (every 15 min).
    const [hasBTN, hasMNT] = await Promise.all([
        hasRateForToday('BOT', rateDate, 'BTN'),
        hasRateForToday('BOT', rateDate, 'MNT'),
    ]);

    if (hasBTN && hasMNT) {
        console.log(`[BLOOMBERG] BTN and MNT already exist for ${rateDate}, skipping BrowserAct`);
        summaries.push({
            source: 'BLOOMBERG',
            status: 'skipped',
            recordsCount: 0,
            durationMs: 0,
        });

        return NextResponse.json({
            success: true,
            summaries,
            totalRates: 0,
        });
    }

    console.log(`[BLOOMBERG] Missing: ${!hasBTN ? 'BTN ' : ''}${!hasMNT ? 'MNT' : ''} for ${rateDate} — calling BrowserAct`);

    // Bloomberg — call BrowserAct (3 workflows: USD-THB, USD-BTN, USD-MNT)
    const bloombergSummary = await fetchWithRetry(new BloombergCollector(), allRates, rateDate, 2);
    summaries.push(bloombergSummary);
    if (bloombergSummary.status === 'success') newDataFetched = true;

    // Only send notification if we actually fetched something new or failed
    if (newDataFetched || bloombergSummary.status === 'failed') {
        try {
            await notifyTeams(summaries, allRates, rateDate);
        } catch (err) {
            console.error('Failed to send Teams notification:', err);
        }
    }

    return NextResponse.json({
        success: true,
        summaries,
        totalRates: allRates.length,
    });
}

async function fetchWithRetry(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string; rawResponse?: any }> },
    allRates: ExchangeRateInsert[],
    rateDate: string,
    maxRetries: number = 3
): Promise<FetchSummary> {
    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    let startMs = Date.now();
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
        console.error(`Failed to create scrape log for ${collector.name}:`, err);
    }

    let attempt = 0;
    while (attempt < maxRetries) {
        attempt++;
        startMs = Date.now();
        console.log(`[${collector.name}] Fetch attempt ${attempt}/${maxRetries}...`);

        try {
            const result = await collector.fetch();
            const durationMs = Date.now() - startMs;

            if (result.rates.length > 0) {
                await insertRates(result.rates);
                allRates.push(...result.rates);

                if (logId) {
                    try {
                        await updateScrapeLog(logId, {
                            status: 'success',
                            completed_at: new Date().toISOString(),
                            records_count: result.rates.length,
                            duration_ms: durationMs,
                            raw_response: result.rawResponse,
                        });
                    } catch (logErr) {
                        console.error(`Failed to update scrape log:`, logErr);
                    }
                }

                return {
                    source: collector.name,
                    status: 'success',
                    recordsCount: result.rates.length,
                    durationMs,
                };
            } else {
                console.warn(`[${collector.name}] Returns 0 rates on attempt ${attempt}`);
                // Save raw_response even when 0 rates for debugging
                if (logId && result.rawResponse) {
                    try {
                        await updateScrapeLog(logId, {
                            raw_response: result.rawResponse,
                        });
                    } catch (logErr) {
                        console.error(`Failed to save raw_response:`, logErr);
                    }
                }
            }
        } catch (err) {
            console.error(`[${collector.name}] Error on attempt ${attempt}:`, err);
        }

        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    const durationMs = Date.now() - startMs;
    const errorMessage = `Exhausted ${maxRetries} retries for ${collector.name}`;

    if (logId) {
        try {
            await updateScrapeLog(logId, {
                status: 'failed',
                completed_at: new Date().toISOString(),
                error_message: errorMessage,
                duration_ms: durationMs,
            });
        } catch (logErr) {
            console.error(`Failed to update scrape log:`, logErr);
        }
    }

    try {
        await notifyTeamsError(collector.name, errorMessage);
    } catch (err) {
        console.error('Failed to send error notification:', err);
    }

    return {
        source: collector.name,
        status: 'failed',
        recordsCount: 0,
        durationMs,
        errorMessage,
    };
}
