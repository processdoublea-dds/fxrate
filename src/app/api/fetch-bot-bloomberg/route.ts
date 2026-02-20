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
import { getPreviousBusinessDate } from '@/collectors/base';

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

    // BOT and Bloomberg use the previous business date
    const rateDate = getPreviousBusinessDate();

    // BOT
    const botSummary = await fetchSourceWithRetryAndDedup(new BotCollector(), allRates, rateDate, 3);
    summaries.push(botSummary);
    if (botSummary.status === 'success') newDataFetched = true;

    // Bloomberg
    const bloombergSummary = await fetchSourceWithRetryAndDedup(new BloombergCollector(), allRates, rateDate, 2); // 2 retries for browseract to stay within 120s Function Limit
    summaries.push(bloombergSummary);
    if (bloombergSummary.status === 'success') newDataFetched = true;

    // Only send notification if we actually fetched something new or failed
    if (newDataFetched || botSummary.status === 'failed' || bloombergSummary.status === 'failed') {
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

async function fetchSourceWithRetryAndDedup(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }> },
    allRates: ExchangeRateInsert[],
    rateDate: string,
    maxRetries: number = 3
): Promise<FetchSummary> {

    // 1. Deduplication check
    // Note: Bloomberg saves as source="BOT", so we check for BLOOMBERG name if it's the collector, but records are BOT.
    // The hasRateForToday function checks the source column. Since Bloomberg creates rows with source='BOT', 
    // it's safer to check if we specifically already have MNT/BTN for that date.
    // For simplicity, we assume if BOT is fetched, we have BOT. If we are running Bloomberg, we just let it run 
    // or rely on a custom query. Since BOT and Bloomberg run at the same time, we'll let supabase handle unique constraints via UI or just run fetch.

    const alreadyFetched = await hasRateForToday(collector.name === 'BLOOMBERG' ? 'BOT' : collector.name, rateDate);

    // If it's bloomberg, alreadyFetched checking "BOT" might be true because the BOT collector just ran.
    // So deduplication here is tricky. A better approach is trusting the task.
    // To be perfectly safe, we'll only strict-dedup if it's BOT.
    if (collector.name === 'BOT' && alreadyFetched) {
        console.log(`${collector.name} already fetched for ${rateDate}, skipping`);
        return {
            source: collector.name,
            status: 'skipped',
            recordsCount: 0,
            durationMs: 0
        };
    }

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
                };
            } else {
                // Returns 0 rates, might be a soft failure, let's retry if we have attempts left
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

    // If we exhausted retries and failed
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
