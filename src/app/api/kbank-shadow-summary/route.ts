import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '30', 10);

    try {
        // Query recent KBANK_SHADOW runs from scrape_logs
        const { data: logs, error } = await supabaseAdmin
            .from('scrape_logs')
            .select('id, started_at, completed_at, status, records_count, duration_ms, error_message, raw_response')
            .eq('source', 'KBANK_SHADOW')
            .order('id', { ascending: false })
            .limit(limit);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const totalRuns = logs ? logs.length : 0;
        let passCount = 0;
        let diffCount = 0;
        let failCount = 0;
        let totalDurationMs = 0;

        const history = (logs || []).map(l => {
            let details = null;
            try {
                details = l.raw_response ? JSON.parse(l.raw_response) : null;
            } catch (_) {}

            const mStatus = details?.match_status || l.status;
            if (mStatus === 'PASS_100_MATCH' || l.status === 'success') passCount++;
            else if (mStatus === 'VARIANCE_DETECTED' || l.status === 'partial') diffCount++;
            else failCount++;

            if (l.duration_ms) totalDurationMs += l.duration_ms;

            return {
                id: l.id,
                tested_at: l.started_at,
                status: l.status,
                match_status: details?.match_status || l.status,
                duration_seconds: l.duration_ms ? (l.duration_ms / 1000).toFixed(1) : '0',
                currencies_checked: l.records_count,
                round: details?.browserless?.round || 'N/A',
                bank_timestamp: details?.browserless?.bank_timestamp || 'N/A',
                diff_count: details?.comparison?.diff_count || 0,
                variances: details?.comparison?.variances || [],
            };
        });

        const avgDurationSeconds = totalRuns > 0 ? (totalDurationMs / totalRuns / 1000).toFixed(1) : '0';
        const passRatePercent = totalRuns > 0 ? ((passCount / totalRuns) * 100).toFixed(1) : '0';

        // Monthly Browserless Quota Consumption Estimate
        // Free tier is 6 hours = 21,600 seconds per month
        const estimatedMonthlySeconds = parseFloat(avgDurationSeconds) * 30 * 2; // assuming 2 runs per day
        const quotaUsedPercent = ((estimatedMonthlySeconds / 21600) * 100).toFixed(2);

        return NextResponse.json({
            title: 'KBANK Shadow Parallel Verification Report (15-30 Days)',
            metrics: {
                total_runs: totalRuns,
                pass_100_match_count: passCount,
                variance_count: diffCount,
                failed_count: failCount,
                pass_rate: `${passRatePercent}%`,
                avg_fetch_duration: `${avgDurationSeconds}s`,
                estimated_monthly_quota_used: `${quotaUsedPercent}% of 6-hour Free Tier`,
            },
            history,
        });

    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
