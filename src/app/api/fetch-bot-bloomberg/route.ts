import { NextResponse } from 'next/server';
import { BotCollector, BloombergCollector, generateRunId } from '@/collectors';
import {
    hasRateForToday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams, notifyTeamsError } from '@/lib/teams-notify';

// Combined BOT + Bloomberg endpoint (single cron to stay within Hobby plan limit)
// Vercel Cron: 30 0 * * 1-5 (UTC 00:30 Mon-Fri = Thailand 07:30)
export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsCount: number;
    durationMs: number;
    errorMessage?: string;
    rateDate?: string;
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

    // === BOT ===
    // rate_date is determined by the API response (whatever date BOT publishes)
    // Use 'USD' for dedup to avoid clash with Bloomberg (which saves BTN/MNT as source='BOT')
    const botSummary = await fetchWithRetry(new BotCollector(), allRates, 3, true, 'USD');
    summaries.push(botSummary);
    if (botSummary.status === 'success') newDataFetched = true;

    // === Bloomberg ===
    // Bloomberg doesn't dedup (source="BOT", upsert handles clashes)
    const bloombergSummary = await fetchWithRetry(new BloombergCollector(), allRates, 2, false);
    summaries.push(bloombergSummary);
    if (bloombergSummary.status === 'success') newDataFetched = true;

    // Use BOT's rate date for notification (fallback to Bloomberg's)
    const rateDate = botSummary.rateDate || bloombergSummary.rateDate || 'unknown';

    // Only send notification if we actually fetched something new or failed
    const hasFailed = summaries.some(s => s.status === 'failed');
    if (newDataFetched || hasFailed) {
        try {
            await notifyTeams(summaries, allRates, rateDate);
        } catch (err) {
            console.error('Failed to send Teams notification:', err);
        }
    }

    return NextResponse.json({
        success: true,
        rateDate,
        summaries,
        totalRates: allRates.length,
    });
}

async function fetchWithRetry(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }> },
    allRates: ExchangeRateInsert[],
    maxRetries: number = 3,
    enableDedup: boolean = true,
    dedupCurrency?: string
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
            const rateDate = result.rateDate;

            if (result.rates.length > 0) {
                // Dedup check (for BOT): only insert if we don't already have this date's data
                if (enableDedup) {
                    const alreadyFetched = await hasRateForToday(collector.name, rateDate, dedupCurrency);
                    if (alreadyFetched) {
                        console.log(`[${collector.name}] Already have data for ${rateDate}, skipping insert`);

                        if (logId) {
                            await updateScrapeLog(logId, {
                                status: 'skipped',
                                completed_at: new Date().toISOString(),
                                records_count: 0,
                                duration_ms: durationMs,
                                error_message: `Data for ${rateDate} already exists`,
                            });
                        }

                        return {
                            source: collector.name,
                            status: 'skipped',
                            recordsCount: 0,
                            durationMs,
                            rateDate,
                        };
                    }
                }

                await insertRates(result.rates);
                allRates.push(...result.rates);

                if (logId) {
                    await updateScrapeLog(logId, {
                        status: 'success',
                        completed_at: new Date().toISOString(),
                        records_count: result.rates.length,
                        duration_ms: durationMs,
                    });
                }

                return {
                    source: collector.name,
                    status: 'success',
                    recordsCount: result.rates.length,
                    durationMs,
                    rateDate,
                };
            } else {
                console.warn(`[${collector.name}] Returns 0 rates on attempt ${attempt}`);
            }
        } catch (err) {
            console.error(`[${collector.name}] Error on attempt ${attempt}:`, err);
        }

        // Wait before retry
        if (attempt < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    const durationMs = Date.now() - startMs;
    const errorMessage = `Exhausted ${maxRetries} retries for ${collector.name}`;

    if (logId) {
        await updateScrapeLog(logId, {
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
            duration_ms: durationMs,
        });
    }

    await notifyTeamsError(collector.name, errorMessage);

    return {
        source: collector.name,
        status: 'failed',
        recordsCount: 0,
        durationMs,
        errorMessage,
    };
}
