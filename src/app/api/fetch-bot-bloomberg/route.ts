import { NextResponse } from 'next/server';
import { BotCollector, BloombergCollector, generateRunId } from '@/collectors';
import {
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams, notifyTeamsError } from '@/lib/teams-notify';

// Vercel Cron: 0 0 * * 1-5 (UTC 00:00 Mon-Fri = Thailand 07:00)
export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial';
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

    // BOT — single fetch, previous day rate
    const botSummary = await fetchSource(new BotCollector(), allRates);
    summaries.push(botSummary);

    // Bloomberg — single fetch, previous day rate
    const bloombergSummary = await fetchSource(new BloombergCollector(), allRates);
    summaries.push(bloombergSummary);

    // Send Teams notification with all results
    const rateDate =
        allRates[0]?.rate_date || new Date().toISOString().split('T')[0];

    try {
        await notifyTeams(summaries, allRates, rateDate);
    } catch (err) {
        console.error('Failed to send Teams notification:', err);
    }

    return NextResponse.json({
        success: true,
        summaries,
        totalRates: allRates.length,
    });
}

async function fetchSource(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }> },
    allRates: ExchangeRateInsert[]
): Promise<FetchSummary> {
    const runId = generateRunId();
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    // Insert initial scrape log
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

    try {
        const result = await collector.fetch();
        const durationMs = Date.now() - startMs;

        if (result.rates.length > 0) {
            await insertRates(result.rates);
            allRates.push(...result.rates);
        }

        // Update log to success
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
            status: result.rates.length > 0 ? 'success' : 'partial',
            recordsCount: result.rates.length,
            durationMs,
        };
    } catch (err) {
        const durationMs = Date.now() - startMs;
        const errorMessage = err instanceof Error ? err.message : String(err);

        // Update log to failed
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
}
