import { NextResponse } from 'next/server';
import { fetchKbankViaBrowserless } from '@/collectors/kbank-browserless';
import { supabaseAdmin, insertScrapeLog } from '@/lib/supabase';
import { generateRunId } from '@/collectors/base';

export const maxDuration = 45; // 45s is well within Vercel Pro 60s/120s limit
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    return handleShadowTest(request);
}

export async function POST(request: Request) {
    return handleShadowTest(request);
}

async function handleShadowTest(request: Request) {
    const url = new URL(request.url);
    const authHeader = request.headers.get('authorization');
    const secretQuery = url.searchParams.get('secret') || url.searchParams.get('key');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret) {
        const isAuthHeaderValid = authHeader === `Bearer ${cronSecret}`;
        const isQueryValid = secretQuery === cronSecret;
        if (!isAuthHeaderValid && !isQueryValid) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }
    }

    const runId = generateRunId();
    const t0 = Date.now();

    try {
        console.log('[KBANK Shadow] Starting Browserless parallel fetch test...');
        const blResult = await fetchKbankViaBrowserless();
        const durationMs = Date.now() - t0;
        console.log(`[KBANK Shadow] Browserless finished in ${durationMs}ms with ${blResult.matchedCount} currencies`);

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

        // Compare each currency
        const variances: any[] = [];
        let matchCount = 0;

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
                const v1 = bl[f];
                const v2 = prod[f];
                // Compare with small floating point tolerance
                if (v1 === null || v1 === undefined || v2 === null || v2 === undefined) {
                    if (v1 !== v2) {
                        diffs[f] = { browserless: v1, browseract: v2 };
                    }
                } else if (Math.abs(Number(v1) - Number(v2)) > 0.0001) {
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

        let matchStatus = 'UNKNOWN';
        if (prodMap.size === 0) {
            matchStatus = 'BROWSERLESS_OK_NO_BROWSERACT_DATA_YET';
        } else if (variances.length === 0 && matchCount === blResult.matchedCount) {
            matchStatus = 'PASS_100_MATCH';
        } else {
            matchStatus = 'VARIANCE_DETECTED';
        }

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
            error_message: variances.length > 0 ? `${variances.length} currency variances found` : null,
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

        return NextResponse.json({
            success: true,
            status: matchStatus,
            summary: comparisonSummary,
        });

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

        return NextResponse.json({
            success: false,
            status: 'FAILED',
            error: err.message,
            duration_ms: durationMs,
        }, { status: 500 });
    }
}
