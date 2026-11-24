import { fetchKbankViaBrowserless } from '@/collectors/kbank-browserless';
import { supabaseAdmin, insertScrapeLog } from '@/lib/supabase';
import { generateRunId } from '@/collectors/base';

export interface KbankShadowRunResult {
    httpStatus: number;
    body: {
        success: boolean;
        status: string;
        reason?: string;
        browserless_round?: string | null;
        bank_timestamp?: string | null;
        summary?: Record<string, any>;
        error?: string;
        duration_ms?: number;
    };
}

export async function runKbankShadowTest(options?: { force?: boolean }): Promise<KbankShadowRunResult> {
    const force = Boolean(options?.force);
    const runId = generateRunId();
    const t0 = Date.now();

    // ── Time Gate: Morning only (08:00 - 10:59 ICT) ──────────────────────────
    const bangkokHour = Number(new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false,
    }));
    if (!force && (bangkokHour < 8 || bangkokHour >= 11)) {
        return {
            httpStatus: 200,
            body: {
                success: true,
                status: 'skipped',
                reason: `Current Bangkok hour (${bangkokHour}:00) is outside morning shadow window (08:00 - 10:59 ICT). Morning rounds only.`,
            },
        };
    }

    // ── Today-Lock Dedup: Already have valid morning capture for today? ───────
    const todayDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const { data: existingShadows } = await supabaseAdmin
        .from('scrape_logs')
        .select('raw_response, status, records_count')
        .eq('source', 'KBANK_SHADOW')
        .gte('started_at', `${todayDate}T00:00:00+07:00`)
        .order('id', { ascending: false });

    let hasMorningCaptureToday = false;
    if (existingShadows) {
        for (const row of existingShadows) {
            try {
                const raw = JSON.parse(row.raw_response);
                const isMorningRound = raw?.browserless?.round === '1' || raw?.browserless?.round === '2';
                const isTodayRate = !raw?.rate_date || raw?.rate_date === todayDate;
                const hasEnoughRecords = (row.records_count ?? 0) >= 20;
                const isValidStatus = row.status !== 'failed' && row.status !== 'skipped';
                if (isMorningRound && isTodayRate && hasEnoughRecords && isValidStatus) {
                    hasMorningCaptureToday = true;
                    break;
                }
            } catch (_) {}
        }
    }

    if (hasMorningCaptureToday && !force) {
        console.log(`[KBANK Shadow] Morning rate already locked for today (${todayDate}) — skipping further runs`);
        return {
            httpStatus: 200,
            body: {
                success: true,
                status: 'skipped',
                reason: `Morning rate already locked for today (${todayDate}). Skipping further runs.`,
            },
        };
    }

    try {
        console.log('[KBANK Shadow] Starting Browserless parallel fetch test (Morning Round 1 / 2)...');
        const blResult = await fetchKbankViaBrowserless();
        const durationMs = Date.now() - t0;
        console.log(`[KBANK Shadow] Browserless finished in ${durationMs}ms with ${blResult.matchedCount} currencies (Round ${blResult.round})`);

        // ── Stale-Date Gate: Skip if KBANK website still serves yesterday's rate ─
        if (!force && blResult.rateDate < todayDate) {
            console.log(`[KBANK Shadow] KBANK website still serving stale date ${blResult.rateDate} (Round ${blResult.round}) — skipping.`);
            const staleSummary = {
                match_status: 'STALE_DATE_SKIPPED',
                tested_at: new Date().toISOString(),
                rate_date: todayDate,
                browserless: {
                    matched_currencies: blResult.matchedCount,
                    round: blResult.round,
                    bank_timestamp: blResult.bankTimestamp,
                    rate_date: blResult.rateDate,
                    duration_ms: durationMs,
                },
            };
            await insertScrapeLog({
                run_id: runId,
                source: 'KBANK_SHADOW',
                status: 'skipped',
                records_count: 0,
                duration_ms: durationMs,
                error_message: `KBANK website still serving stale date ${blResult.rateDate} (Round ${blResult.round})`,
                raw_response: JSON.stringify(staleSummary),
            });
            return {
                httpStatus: 200,
                body: {
                    success: true,
                    status: 'skipped',
                    reason: `KBANK website still serving stale date ${blResult.rateDate} (Round ${blResult.round}). Will retry next round.`,
                    browserless_round: blResult.round,
                    bank_timestamp: blResult.bankTimestamp,
                },
            };
        }

        // ── Round Gate: Only Morning Round 1 or 2 accepted (Round 1 prioritized) ─
        if (!force && blResult.round !== '1' && blResult.round !== '2') {
            console.log(`[KBANK Shadow] Bank is currently at Round ${blResult.round} (not morning Round 1 or 2). Skipping.`);
            return {
                httpStatus: 200,
                body: {
                    success: true,
                    status: 'skipped',
                    reason: `Bank is currently at Round ${blResult.round}. Only morning Round 1 or 2 are accepted (Round 1 prioritized).`,
                    browserless_round: blResult.round,
                    bank_timestamp: blResult.bankTimestamp,
                },
            };
        }

        // Query today's existing KBANK rates in Supabase (from BrowserAct)
        const rateDate = blResult.rateDate;
        const { data: prodRates, error: prodErr } = await supabaseAdmin
            .from('exchange_rates')
            .select('*')
            .eq('source', 'KBANK')
            .eq('rate_date', rateDate);

        if (prodErr) {
            console.error('[KBANK Shadow] Failed to fetch production rates for comparison:', prodErr.message);
        }

        const prodMap = new Map<string, any>();
        let prodTimestamp: string | null = null;
        if (prodRates && prodRates.length > 0) {
            prodRates.forEach(r => {
                prodMap.set(r.currency, r);
                if (r.bank_timestamp && !prodTimestamp) {
                    prodTimestamp = r.bank_timestamp;
                }
            });
        }

        // Compare each currency (strict numerical match with 0 for empty/missing rates)
        const variances: any[] = [];
        let matchCount = 0;

        if (prodMap.size > 0) {
            blResult.rates.forEach(bl => {
                const prod = prodMap.get(bl.currency);
                if (!prod) {
                    variances.push({
                        currency: bl.currency,
                        reason: 'MISSING_IN_BROWSERACT_PROD',
                    });
                    return;
                }

                const diffs: Record<string, { browserless: any; browseract: any }> = {};
                const fields = ['buy_sight', 'buy_tt', 'sell_tt', 'buy_notes', 'sell_notes'] as const;

                fields.forEach(f => {
                    const v1 = Number(bl[f] ?? 0);
                    const v2 = Number(prod[f] ?? 0);

                    if (Math.abs(v1 - v2) > 0.0001) {
                        diffs[f] = { browserless: v1, browseract: v2 };
                    }
                });

                if (Object.keys(diffs).length > 0) {
                    variances.push({
                        currency: bl.currency,
                        diffs,
                    });
                } else {
                    matchCount++;
                }
            });
        }

        let matchStatus = 'UNKNOWN';
        if (prodMap.size === 0) {
            matchStatus = 'BROWSERLESS_OK_NO_BROWSERACT_DATA_YET';
        } else if (variances.length === 0 && matchCount === blResult.matchedCount) {
            matchStatus = 'PASS_100_MATCH';
        } else {
            matchStatus = 'VARIANCE_DETECTED';
        }

        const compactRates: Record<string, {
            buy_sight: number;
            buy_tt: number;
            sell_tt: number;
            buy_notes: number;
            sell_notes: number;
        }> = {};
        blResult.rates.forEach(bl => {
            compactRates[bl.currency] = {
                buy_sight: Number(bl.buy_sight ?? 0),
                buy_tt: Number(bl.buy_tt ?? 0),
                sell_tt: Number(bl.sell_tt ?? 0),
                buy_notes: Number(bl.buy_notes ?? 0),
                sell_notes: Number(bl.sell_notes ?? 0),
            };
        });

        const comparisonSummary = {
            match_status: matchStatus,
            tested_at: new Date().toISOString(),
            rate_date: rateDate,
            browserless: {
                matched_currencies: blResult.matchedCount,
                round: blResult.round,
                bank_timestamp: blResult.bankTimestamp,
                duration_ms: durationMs,
            },
            browserless_rates: compactRates,
            browseract: {
                found_currencies: prodMap.size,
                bank_timestamp: prodTimestamp,
            },
            comparison: {
                currencies_checked: blResult.matchedCount,
                match_count: matchCount,
                diff_count: variances.length,
                variances,
            },
        };

        // 1. Log to scrape_logs (source: 'KBANK_SHADOW')
        await insertScrapeLog({
            run_id: runId,
            source: 'KBANK_SHADOW',
            status: matchStatus === 'PASS_100_MATCH' ? 'success' : 'partial',
            records_count: blResult.matchedCount,
            duration_ms: durationMs,
            error_message: prodMap.size > 0 && variances.length > 0 ? `${variances.length} currency variances found` : null,
            raw_response: JSON.stringify(comparisonSummary),
        });

        // 2. Try logging to dedicated table kbank_shadow_comparison if it exists
        try {
            await supabaseAdmin.from('kbank_shadow_comparison').insert({
                rate_date: rateDate,
                match_status: matchStatus,
                currencies_checked: blResult.matchedCount,
                diff_count: variances.length,
                browserless_timestamp: blResult.bankTimestamp,
                browserless_round: blResult.round,
                browserless_duration_ms: durationMs,
                browserless_rates: blResult.rates,
                browseract_timestamp: prodTimestamp,
                variance_details: variances,
            });
        } catch (_) {
            // Ignore if table does not exist
        }

        return {
            httpStatus: 200,
            body: {
                success: true,
                status: matchStatus,
                summary: comparisonSummary,
            },
        };

    } catch (err: any) {
        console.error('[KBANK Shadow] Error during test:', err);
        const durationMs = Date.now() - t0;

        await insertScrapeLog({
            run_id: runId,
            source: 'KBANK_SHADOW',
            status: 'failed',
            records_count: 0,
            duration_ms: durationMs,
            error_message: err.message,
            raw_response: JSON.stringify({ error: err.message, stack: err.stack }),
        });

        return {
            httpStatus: 500,
            body: {
                success: false,
                status: 'FAILED',
                error: err.message,
                duration_ms: durationMs,
            },
        };
    }
}
