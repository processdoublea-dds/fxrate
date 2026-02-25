import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { notifyTeamsVerification } from '@/lib/teams-notify';

export const maxDuration = 60; // 1 min

export async function GET(request: NextRequest) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Check completeness in scrape_logs for the last 14 hours
        // Since Vercel uses UTC, 14 hours is a safe window to capture today's 07:00-08:50 ICT runs.
        const fourteenHoursAgo = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();
        const { data: logs, error: logError } = await supabaseAdmin
            .from('scrape_logs')
            .select('source, status')
            .gte('started_at', fourteenHoursAgo)
            .eq('status', 'success');

        if (logError) throw logError;

        const expectedSources = ['BOT', 'BLOOMBERG', 'SCB', 'KTB', 'KBANK'];
        const actualSources = new Set(logs?.map((l: any) => l.source) || []);
        const missingSources = expectedSources.filter(s => !actualSources.has(s));
        const allComplete = missingSources.length === 0;

        // 2. Run Comparison
        const host = request.headers.get('host') || 'localhost:3000';
        const proto = request.headers.get('x-forwarded-proto') || 'https';
        const compareUrl = `${proto}://${host}/api/compare`;

        const compRes = await fetch(compareUrl, { next: { revalidate: 0 } });
        let comparisonStats = null;
        let rateDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

        if (compRes.ok) {
            const compData = await compRes.json();
            comparisonStats = compData.summary;
            if (compData.date) rateDate = compData.date;
        } else {
            console.error('Compare API failed:', compRes.status);
        }

        // 3. Notify Teams
        await notifyTeamsVerification(allComplete, missingSources, comparisonStats, rateDate);

        return NextResponse.json({
            success: true,
            allComplete,
            missingSources,
            comparisonStats
        });

    } catch (error) {
        console.error('Verify daily failed:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
