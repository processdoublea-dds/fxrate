import { NextRequest, NextResponse } from 'next/server';
import {
    BotCollector,
    BloombergCollector,
    ScbCollector,
    KtbCollector,
    KbankCollector,
    generateRunId,
    getTodayDate,
} from '@/collectors';
import { getYesterdayDate } from '@/collectors/base';
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

// Backward-compatible endpoint — runs all sources in parallel
// Prefer using individual endpoints (/api/fetch-bot, /api/fetch-bloomberg, /api/fetch-thai-banks)
// via GAS fetchAll for better timeout isolation.
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

export async function GET(request: NextRequest) {
    // Verify cron secret
    const authHeader = request.headers.get('authorization');
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const isFinalRound = searchParams.get('final') === 'true';

    const todayDate = getTodayDate();
    const summaries: FetchSummary[] = [];
    const allRates: ExchangeRateInsert[] = [];
    let newDataFetched = false;

    // ── Check Holiday ──
    const holidayName = await isBankHoliday(todayDate);
    if (holidayName) {
        console.log(`Today (${todayDate}) is a holiday: ${holidayName}. Skipping Thai Banks.`);

        const alreadyNotified = await hasRateForToday('Bank Holiday System', todayDate);
        if (!alreadyNotified) {
            await notifyTeamsHoliday(todayDate, holidayName);
            await insertScrapeLog({
                run_id: generateRunId(),
                source: 'Bank Holiday System',
                status: 'skipped',
                started_at: new Date().toISOString(),
                completed_at: new Date().toISOString(),
                records_count: 0,
                duration_ms: 0,
                error_message: `Holiday: ${holidayName}`
            });
            await insertRates([{
                run_id: generateRunId(),
                source: 'Bank Holiday System',
                currency: 'HOLIDAY',
                buy_tt: 0,
                sell_tt: 0,
                rate_date: todayDate,
                bank_timestamp: new Date().toISOString()
            }]);
        }

        for (const name of ['SCB', 'KTB', 'KBANK']) {
            summaries.push({
                source: name,
                status: 'skipped',
                recordsCount: 0,
                durationMs: 0,
                errorMessage: `Holiday: ${holidayName}`,
            });
        }
    }

    // ── Determine Bloomberg rateDate independently ──
    // Bloomberg always uses yesterday's calendar date (not previous business date)
    const bloombergRateDate = getYesterdayDate();
    const hasBTN = await hasRateForToday('BOT', bloombergRateDate, 'BTN');
    const hasMNT = await hasRateForToday('BOT', bloombergRateDate, 'MNT');

    // ── Build parallel tasks ──
    interface TaskResult {
        summary: FetchSummary;
        rates: ExchangeRateInsert[];
    }

    const tasks: { key: string; promise: Promise<TaskResult> }[] = [];

    // BOT (always runs)
    tasks.push({
        key: 'bot',
        promise: (async () => {
            const localRates: ExchangeRateInsert[] = [];
            const summary = await fetchWithRetry(new BotCollector(), localRates, 3, true, 'USD');
            return { summary, rates: localRates };
        })(),
    });

    // Bloomberg (skip if both BTN and MNT exist)
    if (hasBTN && hasMNT) {
        console.log('[BLOOMBERG] Both BTN and MNT exist, skipping');
        summaries.push({ source: 'BLOOMBERG', status: 'skipped', recordsCount: 0, durationMs: 0, rateDate: bloombergRateDate });
    } else {
        console.log(`[BLOOMBERG] Missing: ${!hasBTN ? 'BTN ' : ''}${!hasMNT ? 'MNT' : ''} — fetching...`);
        tasks.push({
            key: 'bloomberg',
            promise: (async () => {
                const localRates: ExchangeRateInsert[] = [];
                const summary = await fetchWithRetry(new BloombergCollector(), localRates, 2, false);
                return { summary, rates: localRates };
            })(),
        });
    }

    // Thai Banks (only if not holiday AND after 08:00 Bangkok time)
    const bangkokHour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }));
    if (!holidayName && bangkokHour >= 8) {
        for (const CollectorClass of [ScbCollector, KtbCollector, KbankCollector]) {
            tasks.push({
                key: CollectorClass.name,
                promise: (async () => {
                    const collector = new CollectorClass();
                    const localRates: ExchangeRateInsert[] = [];
                    const summary = await fetchBankWithRetry(collector, localRates, todayDate, 3);
                    return { summary, rates: localRates };
                })(),
            });
        }
    } else if (!holidayName) {
        console.log(`[FETCH-ALL] Bangkok hour is ${bangkokHour}, skipping Thai banks (too early)`);
        for (const name of ['SCB', 'KTB', 'KBANK']) {
            summaries.push({ source: name, status: 'skipped', recordsCount: 0, durationMs: 0, errorMessage: `Too early (hour: ${bangkokHour})` });
        }
    }

    // ── Run ALL tasks in parallel ──
    const results = await Promise.allSettled(tasks.map(t => t.promise));

    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
            summaries.push(result.value.summary);
            allRates.push(...result.value.rates);
            if (result.value.summary.status === 'success') newDataFetched = true;
        } else {
            console.error(`Task ${tasks[i].key} rejected:`, result.reason);
            summaries.push({
                source: tasks[i].key.toUpperCase(),
                status: 'failed',
                recordsCount: 0,
                durationMs: 0,
                errorMessage: String(result.reason),
            });
        }
    }

    // ── Determine overall status ──
    const allComplete = summaries.every(s => s.status === 'success' || s.status === 'skipped');
    const hasFailed = summaries.some(s => s.status === 'failed');
    const botSummary = summaries.find(s => s.source === 'BOT');
    const rateDate = botSummary?.rateDate || todayDate;

    // ── Notifications ──
    if (newDataFetched || hasFailed) {
        try {
            await notifyTeams(summaries, allRates, rateDate);
        } catch (err) {
            console.error('Failed to send Teams notification:', err);
        }
    }

    if (isFinalRound || (allComplete && !newDataFetched)) {
        try {
            await notifyFinalSummary(summaries, rateDate, todayDate);
        } catch (err) {
            console.error('Failed to send final summary:', err);
        }
    }

    if (newDataFetched) {
        try {
            const deleted = await deleteOldScrapeLogs(60);
            if (deleted > 0) console.log(`Cleaned up ${deleted} old scrape logs`);
        } catch (err) {
            console.error('Cleanup failed:', err);
        }
    }

    return NextResponse.json({
        success: true,
        rateDate,
        todayDate,
        allComplete,
        newDataFetched,
        summaries,
        totalNewRates: allRates.length,
    });
}

// ── BOT/Bloomberg fetch (rate_date from collector) ──
async function fetchWithRetry(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }> },
    allRates: ExchangeRateInsert[],
    maxRetries: number,
    enableDedup: boolean,
    dedupCurrency?: string
): Promise<FetchSummary> {
    const runId = generateRunId();
    let startMs = Date.now();
    let logId: number | null = null;

    try {
        const log = await insertScrapeLog({
            run_id: runId, source: collector.name, status: 'partial',
            started_at: new Date().toISOString(),
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
                if (enableDedup) {
                    const EXPECTED_COUNTS: Record<string, number> = { BOT: 23, BLOOMBERG: 2 };
                    const expected = EXPECTED_COUNTS[collector.name];
                    const alreadyFetched = await hasRateForToday(collector.name, rateDate, dedupCurrency, expected);
                    if (alreadyFetched) {
                        console.log(`[${collector.name}] Already have complete data (${expected}) for ${rateDate}, skipping`);
                        if (logId) {
                            try { await updateScrapeLog(logId, { status: 'skipped', completed_at: new Date().toISOString(), records_count: 0, duration_ms: durationMs, error_message: `Data for ${rateDate} already exists` }); }
                            catch (e) { console.error(`Failed to update scrape log:`, e); }
                        }
                        return { source: collector.name, status: 'skipped', recordsCount: 0, durationMs, rateDate };
                    }
                }

                await insertRates(result.rates);
                allRates.push(...result.rates);
                if (logId) {
                    try { await updateScrapeLog(logId, { status: 'success', completed_at: new Date().toISOString(), records_count: result.rates.length, duration_ms: durationMs }); }
                    catch (e) { console.error(`Failed to update scrape log:`, e); }
                }
                return { source: collector.name, status: 'success', recordsCount: result.rates.length, durationMs, rateDate };
            } else {
                console.warn(`[${collector.name}] Returns 0 rates on attempt ${attempt}`);
            }
        } catch (err) {
            console.error(`[${collector.name}] Error on attempt ${attempt}:`, err);
        }

        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 5000));
    }

    const durationMs = Date.now() - startMs;
    const errorMessage = `Exhausted ${maxRetries} retries for ${collector.name}`;
    if (logId) {
        try { await updateScrapeLog(logId, { status: 'failed', completed_at: new Date().toISOString(), error_message: errorMessage, duration_ms: durationMs }); }
        catch (e) { console.error(`Failed to update scrape log:`, e); }
    }
    await notifyTeamsError(collector.name, errorMessage);
    return { source: collector.name, status: 'failed', recordsCount: 0, durationMs, errorMessage };
}

// ── Thai Bank fetch (rate_date = today, timestamp validation) ──
async function fetchBankWithRetry(
    collector: { name: string; fetch: () => Promise<{ rates: ExchangeRateInsert[]; rateDate: string }> },
    allRates: ExchangeRateInsert[],
    rateDate: string,
    maxRetries: number
): Promise<FetchSummary> {
    const EXPECTED_COUNTS: Record<string, number> = {
        SCB: 27,
        KTB: 22,
        KBANK: 26,
    };
    const expected = EXPECTED_COUNTS[collector.name];
    const alreadyFetched = await hasRateForToday(collector.name, rateDate, undefined, expected);
    if (alreadyFetched) {
        console.log(`[${collector.name}] Already fetched (complete: ${expected}) for ${rateDate}, skipping`);
        return { source: collector.name, status: 'skipped', recordsCount: 0, durationMs: 0 };
    }

    const runId = generateRunId();
    let startMs = Date.now();
    let logId: number | null = null;

    try {
        const log = await insertScrapeLog({
            run_id: runId, source: collector.name, status: 'partial',
            started_at: new Date().toISOString(),
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
            let fetchedRates = result.rates.filter(r => {
                if (!r.bank_timestamp) return false; // No datetime = reject (safety net)
                const bankTs = new Date(r.bank_timestamp);
                const bankDate = bankTs.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
                if (bankDate < result.rateDate) return false;
                // Reject rates published before 08:00 Bangkok time
                const bankHour = Number(bankTs.toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }));
                return bankHour >= 8;
            });

            const durationMs = Date.now() - startMs;

            if (fetchedRates.length > 0) {
                await insertRates(fetchedRates);
                allRates.push(...fetchedRates);
                if (logId) {
                    try { await updateScrapeLog(logId, { status: 'success', completed_at: new Date().toISOString(), records_count: fetchedRates.length, duration_ms: durationMs }); }
                    catch (e) { console.error(`Failed to update scrape log:`, e); }
                }
                return { source: collector.name, status: 'success', recordsCount: fetchedRates.length, durationMs };
            } else {
                console.warn(`[${collector.name}] Returns 0 valid rates on attempt ${attempt}`);
            }
        } catch (err) {
            console.error(`[${collector.name}] Error on attempt ${attempt}:`, err);
        }

        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 5000));
    }

    const durationMs = Date.now() - startMs;
    if (logId) {
        try { await updateScrapeLog(logId, { status: 'skipped', completed_at: new Date().toISOString(), error_message: `Bank rates may not be published yet`, records_count: 0, duration_ms: durationMs }); }
        catch (e) { console.error(`Failed to update scrape log:`, e); }
    }
    return { source: collector.name, status: 'skipped', recordsCount: 0, durationMs };
}

// ── Final Summary Notification ──
async function notifyFinalSummary(summaries: FetchSummary[], rateDate: string, todayDate: string) {
    const WEBHOOK_URL = process.env.MS_TEAMS_WEBHOOK_URL;
    if (!WEBHOOK_URL) return;

    const statusEmoji = (s: string) => {
        if (s === 'success') return '✅';
        if (s === 'skipped') return '⏭️';
        if (s === 'failed') return '❌';
        return '⚠️';
    };

    const lines = summaries.map(s =>
        `${statusEmoji(s.status)} **${s.source}**: ${s.status} (${s.recordsCount} records)`
    );

    const allComplete = summaries.every(s => s.status === 'success' || s.status === 'skipped');
    const title = allComplete
        ? `📋 FX Rate Final Summary — All Complete ✅`
        : `📋 FX Rate Final Summary — Incomplete ⚠️`;

    const card = {
        type: 'message',
        attachments: [{
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.4',
                body: [
                    { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium' },
                    { type: 'TextBlock', text: `**Rate Date:** ${rateDate} | **Today:** ${todayDate}`, size: 'Small' },
                    { type: 'TextBlock', text: lines.join('\n\n'), wrap: true },
                ],
                actions: [
                    { type: 'Action.OpenUrl', title: '📊 View Dashboard', url: 'https://fxrate-aa.vercel.app/' }
                ]
            }
        }]
    };

    await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(card),
    });
}
