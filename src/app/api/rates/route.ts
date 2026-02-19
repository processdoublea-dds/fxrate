import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toISOString().split('T')[0];

    // Fetch rates for the date
    const { data: rates, error: ratesError } = await supabaseAdmin
        .from('exchange_rates')
        .select('*')
        .eq('rate_date', date)
        .order('source')
        .order('currency');

    if (ratesError) {
        return NextResponse.json({ error: ratesError.message }, { status: 500 });
    }

    // Fetch scrape logs for the date
    const { data: logs, error: logsError } = await supabaseAdmin
        .from('scrape_logs')
        .select('*')
        .gte('started_at', `${date}T00:00:00+07:00`)
        .lte('started_at', `${date}T23:59:59+07:00`)
        .order('started_at', { ascending: false });

    if (logsError) {
        return NextResponse.json({ error: logsError.message }, { status: 500 });
    }

    // Group rates by source
    const sources = ['BOT', 'SCB', 'KTB', 'KBANK', 'BLOOMBERG'];
    const summary = sources.map((source) => {
        const sourceRates = (rates || []).filter((r) => r.source === source);
        const sourceLog = (logs || []).find((l) => l.source === source);
        return {
            source,
            count: sourceRates.length,
            status: sourceLog?.status || (sourceRates.length > 0 ? 'success' : 'none'),
            lastFetch: sourceLog?.started_at || null,
            durationMs: sourceLog?.duration_ms || null,
        };
    });

    return NextResponse.json({
        date,
        rates: rates || [],
        summary,
    });
}
