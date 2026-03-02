import { NextResponse } from 'next/server';
import {
    ScbCollector,
    KtbCollector,
    KbankCollector,
    generateRunId,
} from '@/collectors';
import {
    hasRateForToday,
    isBankHoliday,
    insertRates,
    insertScrapeLog,
    updateScrapeLog,
    deleteOldScrapeLogs,
    ExchangeRateInsert,
} from '@/lib/supabase';
import { notifyTeams, notifyTeamsError, notifyTeamsHoliday } from '@/lib/teams-notify';
import { getTodayDate } from '@/collectors/base';

// Vercel Cron: */10 0-1 * * 1-5 (UTC 00:00-01:59 Mon-Fri = Thailand 07:00-08:59)
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

    // DEDUP: Check if today is an official bank holiday
    const holidayName = await isBankHoliday(rateDate);
    if (holidayName) {
        console.log(`Today (${rateDate}) is an official holiday: ${holidayName}. Skipping Thai Banks fetch.`);

        // Notify teams only if this is the first execution attempt of the day (e.g., around 07:00)
        // We can approximate this by checking if we have already sent a skipped log for this date 
        // to avoid spamming the user every 10 mins.
        // Actually, since it's simple, just log a generic scrape log and let notifyTeams decide, 
        // or just notify teams if there isn't a 'holiday_skipped' log today.
        // For simplicity, we can do a quick check:
        const alreadyNotified = await hasRateForToday('Bank Holiday System', rateDate);
        if (!alreadyNotified) {
            await notifyTeamsHoliday(rateDate, holidayName);
            await insertScrapeLog({
                run_id: generateRunId(),
                source: 'Bank Holiday System',
                status: 'skipped',
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                records_count: 0,
                duration_ms: 0,
                error_message: `Skipped due to holiday: ${holidayName}`
            });
            // Insert a generic tracker to deduplicate notifications for the rest of the day
            await insertRates([{
                run_id: generateRunId(),
                source: 'Bank Holiday System',
                currency: 'HOLIDAY',
                buy_tt: 0,
                sell_tt: 0,
                rate_date: rateDate,
                bank_timestamp: new Date().toISOString()
            }]);
        }

        return NextResponse.json({
            success: true,
            holiday: holidayName,
            status: 'holiday_skipped'
        });
    }

    const summaries: FetchSummary[] = [];
    const allRates: ExchangeRateInsert[] = [];
    let newDataFetched = false;

    for (const collector of BANK_COLLECTORS) {
        const summary = await fetchSourceWithRetryAndDedup(collector, allRates, rateDate, 3);
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

    // Run periodic data cleanup (Delete logs older than 60 days)
    let deletedLogsCount = 0;
    try {
        deletedLogsCount = await deleteOldScrapeLogs(60);
        if (deletedLogsCount > 0) {
            console.log(`Cleaned up ${deletedLogsCount} old scrape logs`);
        }
    } catch (err) {
        console.error('Failed to run data cleanup:', err);
    }

    return NextResponse.json({
        success: true,
        rateDate,
        summaries,
        totalNewRates: allRates.length,
        deletedLogsCount,
    });
}

async function fetchSourceWithRetryAndDedup(
    collector: {
        name: string;
        fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }>;
    },
    allRates: ExchangeRateInsert[],
    rateDate: string,
    maxRetries: number = 3
): Promise<FetchSummary> {

    // DEDUP: Check if rate already exists for today
    const alreadyFetched = await hasRateForToday(collector.name, rateDate);
    if (alreadyFetched) {
        console.log(`${collector.name} already fetched for ${rateDate}, skipping`);
        return {
            source: collector.name,
            status: 'skipped',
            recordsCount: 0,
            durationMs: 0,
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
            let fetchedRates = result.rates;

            // Ensure we only insert rates that actually belong to today (or newer).
            // If the bank's website hasn't updated yet and still shows yesterday's timestamp, discard them.
            fetchedRates = fetchedRates.filter(r => {
                if (!r.bank_timestamp) return true;
                const bankDate = new Date(r.bank_timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
                return bankDate >= result.rateDate;
            });

            const durationMs = Date.now() - startMs;

            if (fetchedRates.length > 0) {
                await insertRates(fetchedRates);
                allRates.push(...fetchedRates);

                if (logId) {
                    await updateScrapeLog(logId, {
                        status: 'success',
                        completed_at: new Date().toISOString(),
                        records_count: fetchedRates.length,
                        duration_ms: durationMs,
                    });
                }

                return {
                    source: collector.name,
                    status: 'success',
                    recordsCount: fetchedRates.length,
                    durationMs,
                };
            } else {
                // Returns 0 rates (bank timestamp still yesterday), retry if attempts left
                console.warn(`[${collector.name}] Returns 0 valid rates on attempt ${attempt} (bank may not have updated yet)`);
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
    const errorMessage = `Exhausted ${maxRetries} retries for ${collector.name} — bank rates may not be published yet`;

    if (logId) {
        await updateScrapeLog(logId, {
            status: 'skipped',
            completed_at: new Date().toISOString(),
            error_message: errorMessage,
            records_count: 0,
            duration_ms: durationMs,
        });
    }

    return {
        source: collector.name,
        status: 'skipped',
        recordsCount: 0,
        durationMs,
    };
}
