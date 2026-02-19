import { NextResponse } from 'next/server';
import {
    ScbCollector,
    KtbCollector,
    KbankCollector,
    generateRunId,
} from '@/collectors';
import {
    hasRateForToday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams, notifyTeamsError } from '@/lib/teams-notify';
import { getTodayDate } from '@/collectors/base';

// Vercel Cron: */10 1 * * 1-5 (UTC 01:00-01:50 Mon-Fri = Thailand 08:00-08:50)
export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

interface FetchSummary {
    source: string;
    status: 'success' | 'failed' | 'partial' | 'skipped';
    recordsCount: number;
    durationMs: number;
    errorMessage?: string;
}

const BANK_COLLECTORS = [
    new ScbCollector(),
    new KtbCollector(),
    new KbankCollector(),
];

export async function GET(request: Request) {
    // Verify cron secret in production
    const authHeader = request.headers.get('authorization');
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateDate = getTodayDate();
    const summaries: FetchSummary[] = [];
    const allRates: ExchangeRateInsert[] = [];
    let newDataFetched = false;

    for (const collector of BANK_COLLECTORS) {
        // DEDUP: Check if rate already exists for today
        const alreadyFetched = await hasRateForToday(collector.name, rateDate);

        if (alreadyFetched) {
            summaries.push({
                source: collector.name,
                status: 'skipped',
                recordsCount: 0,
                durationMs: 0,
            });
            console.log(
                `${collector.name} already fetched for ${rateDate}, skipping`
            );
            continue;
        }

        // Fetch new rates
        const summary = await fetchSource(collector, allRates);
        summaries.push(summary);

        if (summary.status === 'success') {
            newDataFetched = true;
        }
    }

    // Only send notification if we actually fetched new data
    if (newDataFetched) {
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
        totalNewRates: allRates.length,
    });
}

async function fetchSource(
    collector: {
        name: string;
        fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }>;
    },
    allRates: ExchangeRateInsert[]
): Promise<FetchSummary> {
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
        console.error(`Failed to create scrape log for ${collector.name}:`, err);
    }

    try {
        const result = await collector.fetch();
        const durationMs = Date.now() - startMs;

        if (result.rates.length > 0) {
            await insertRates(result.rates);
            allRates.push(...result.rates);
        }

        if (logId) {
            await updateScrapeLog(logId, {
                status: result.rates.length > 0 ? 'success' : 'partial',
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
