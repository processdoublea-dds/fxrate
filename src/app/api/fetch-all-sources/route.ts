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

// Unified endpoint for all 5 sources
// Called by Google Apps Script trigger every 15 min (07:45-09:00 ICT)
// Also used as Vercel Cron backup
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
        // Holiday skip for Thai banks (BOT + Bloomberg still run)
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

        // Add skipped summaries for Thai banks
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

    // ── BOT (rate_date from API, dedup by USD) ──
    const botSummary = await fetchWithRetry(
        new BotCollector(), allRates, 3, true, 'USD'
    );
    summaries.push(botSummary);
    if (botSummary.status === 'success') newDataFetched = true;

    // ── Bloomberg (check both BTN and MNT before calling BrowserAct) ──
    // Bloomberg runs 3 separate BrowserAct workflows (USDTHB, USDMNT, USDMNT)
    // then calculates cross rates → stores BTN and MNT as source="BOT"
    const bloombergRateDate = botSummary.rateDate || todayDate;
    const hasBTN = await hasRateForToday('BOT', bloombergRateDate, 'BTN');
    const hasMNT = await hasRateForToday('BOT', bloombergRateDate, 'MNT');

    let bloombergSummary: FetchSummary;
    if (hasBTN && hasMNT) {
        console.log('[BLOOMBERG] Both BTN and MNT exist, skipping');
        bloombergSummary = { source: 'BLOOMBERG', status: 'skipped', recordsCount: 0, durationMs: 0, rateDate: bloombergRateDate };
    } else {
        console.log(`[BLOOMBERG] Missing: ${!hasBTN ? 'BTN ' : ''}${!hasMNT ? 'MNT' : ''} — fetching...`);
        bloombergSummary = await fetchWithRetry(
            new BloombergCollector(), allRates, 2, false
        );
    }
    summaries.push(bloombergSummary);
    if (bloombergSummary.status === 'success') newDataFetched = true;

    // ── Thai Banks (only if not holiday) ──
    if (!holidayName) {
        for (const CollectorClass of [ScbCollector, KtbCollector, KbankCollector]) {
            const collector = new CollectorClass();
            const summary = await fetchBankWithRetry(collector, allRates, todayDate, 3);
            summaries.push(summary);
            if (summary.status === 'success') newDataFetched = true;
        }
    }

    // ── Determine overall status ──
    const allComplete = summaries.every(s => s.status === 'success' || s.status === 'skipped');
    const hasFailed = summaries.some(s => s.status === 'failed');
    const rateDate = botSummary.rateDate || todayDate;

    // ── Notifications ──
    // Per-round: only if something new happened or failed
    if (newDataFetched || hasFailed) {
        try {
            await notifyTeams(summaries, allRates, rateDate);
        } catch (err) {
            console.error('Failed to send Teams notification:', err);
        }
    }

    // Final summary: when GAS sends final=true OR all sources complete
    if (isFinalRound || (allComplete && !newDataFetched)) {
        // All sources already fetched — send a clean summary
        try {
            await notifyFinalSummary(summaries, rateDate, todayDate);
        } catch (err) {
            console.error('Failed to send final summary:', err);
        }
    }

    // Periodic cleanup (only on first successful round)
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
                    const alreadyFetched = await hasRateForToday(collector.name, rateDate, dedupCurrency);
                    if (alreadyFetched) {
                        console.log(`[${collector.name}] Already have data for ${rateDate}, skipping`);
                        if (logId) await updateScrapeLog(logId, { status: 'skipped', completed_at: new Date().toISOString(), records_count: 0, duration_ms: durationMs, error_message: `Data for ${rateDate} already exists` });
                        return { source: collector.name, status: 'skipped', recordsCount: 0, durationMs, rateDate };
                    }
                }

                await insertRates(result.rates);
                allRates.push(...result.rates);
                if (logId) await updateScrapeLog(logId, { status: 'success', completed_at: new Date().toISOString(), records_count: result.rates.length, duration_ms: durationMs });
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
    if (logId) await updateScrapeLog(logId, { status: 'failed', completed_at: new Date().toISOString(), error_message: errorMessage, duration_ms: durationMs });
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
    // Dedup: check DB first
    const alreadyFetched = await hasRateForToday(collector.name, rateDate);
    if (alreadyFetched) {
        console.log(`[${collector.name}] Already fetched for ${rateDate}, skipping`);
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
            // Filter out rates where bank_timestamp is still yesterday
            let fetchedRates = result.rates.filter(r => {
                if (!r.bank_timestamp) return true;
                const bankDate = new Date(r.bank_timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
                return bankDate >= result.rateDate;
            });

            const durationMs = Date.now() - startMs;

            if (fetchedRates.length > 0) {
                await insertRates(fetchedRates);
                allRates.push(...fetchedRates);
                if (logId) await updateScrapeLog(logId, { status: 'success', completed_at: new Date().toISOString(), records_count: fetchedRates.length, duration_ms: durationMs });
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
    if (logId) await updateScrapeLog(logId, { status: 'skipped', completed_at: new Date().toISOString(), error_message: `Bank rates may not be published yet`, records_count: 0, duration_ms: durationMs });
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
