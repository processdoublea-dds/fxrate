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

        const rateDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

        // 2. Notify Teams
        await notifyTeamsVerification(allComplete, missingSources, rateDate);

        return NextResponse.json({
            success: true,
            allComplete,
            missingSources
        });

    } catch (error) {
        console.error('Verify daily failed:', error);
        return NextResponse.json({ error: String(error) }, { status: 500 });
    }
}
