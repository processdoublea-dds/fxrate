import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * Get previous business date (skip weekends) from a given date
 */
function getPreviousBusinessDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() - 1);
    }
    return d.toISOString().split('T')[0];
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

    // BOT + Bloomberg use the previous business date
    const botDate = getPreviousBusinessDate(date);

    // Fetch Thai bank rates for today
    const { data: bankRates, error: bankError } = await supabaseAdmin
        .from('exchange_rates')
        .select('*')
        .eq('rate_date', date)
        .in('source', ['SCB', 'KTB', 'KBANK'])
        .order('source')
        .order('currency');

    if (bankError) {
        return NextResponse.json({ error: bankError.message }, { status: 500 });
    }

    // Fetch BOT + Bloomberg rates from previous business date
    const { data: botRates, error: botError } = await supabaseAdmin
        .from('exchange_rates')
        .select('*')
        .eq('rate_date', botDate)
        .in('source', ['BOT', 'BLOOMBERG'])
        .order('source')
        .order('currency');

    if (botError) {
        return NextResponse.json({ error: botError.message }, { status: 500 });
    }

    // Combine all rates
    const allRates = [...(bankRates || []), ...(botRates || [])];

    // Fetch scrape logs for today (all sources)
    const { data: logs, error: logsError } = await supabaseAdmin
        .from('scrape_logs')
        .select('*')
        .gte('started_at', `${date}T00:00:00+07:00`)
        .lte('started_at', `${date}T23:59:59+07:00`)
        .order('started_at', { ascending: false });

    if (logsError) {
        return NextResponse.json({ error: logsError.message }, { status: 500 });
    }

    // BOT + Bloomberg merged summary
    const botCount = (botRates || []).filter((r) => r.source === 'BOT').length;
    const bloombergCount = (botRates || []).filter((r) => r.source === 'BLOOMBERG').length;

    // Thai bank summaries
    const bankSources = ['SCB', 'KTB', 'KBANK'];
    const bankSummaries = bankSources.map((source) => {
        const sourceRates = (bankRates || []).filter((r) => r.source === source);
        const sourceLog = (logs || []).find((l) => l.source === source);
        return {
            source,
            count: sourceRates.length,
            status: sourceLog?.status || (sourceRates.length > 0 ? 'success' : 'none'),
            lastFetch: sourceLog?.started_at || null,
            durationMs: sourceLog?.duration_ms || null,
        };
    });

    // BOT+Bloomberg merged summary
    const botLog = (logs || []).find((l) => l.source === 'BOT');
    const bloombergLog = (logs || []).find((l) => l.source === 'BLOOMBERG');
    const botBloombergSummary = {
        source: 'BOT',
        count: botCount + bloombergCount,
        status: botLog?.status || (botCount > 0 ? 'success' : 'none'),
        lastFetch: botLog?.started_at || bloombergLog?.started_at || null,
        durationMs: botLog?.duration_ms || null,
        botDate, // Include the actual date BOT data comes from
    };

    return NextResponse.json({
        date,
        botDate,
        rates: allRates,
        summary: [botBloombergSummary, ...bankSummaries],
    });
}
