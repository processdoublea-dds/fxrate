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
        .select('id, run_id, rate_date, source, currency, currency_label, sell_tt, sell_notes, buy_tt, buy_sight, buy_transfer, buy_notes, mid_rate, bank_timestamp, fetched_at')
        .eq('rate_date', date)
        .in('source', ['SCB', 'KTB', 'KBANK'])
        .order('source')
        .order('currency');

    if (bankError) {
        return NextResponse.json({ error: bankError.message }, { status: 500 });
    }

    // Fetch BOT + Bloomberg rates — check BOTH current date AND previous business date
    // (BOT collector may store rate_date as today or as the previous business date)
    const { data: botRates, error: botError } = await supabaseAdmin
        .from('exchange_rates')
        .select('id, run_id, rate_date, source, currency, currency_label, sell_tt, sell_notes, buy_tt, buy_sight, buy_transfer, buy_notes, mid_rate, bank_timestamp, fetched_at')
        .in('rate_date', [date, botDate])
        .in('source', ['BOT', 'BLOOMBERG'])
        .order('source')
        .order('currency');

    if (botError) {
        return NextResponse.json({ error: botError.message }, { status: 500 });
    }

    // Deduplicate BOT rates — if same currency exists for both dates, prefer current date
    const botDeduped = deduplicateRates(botRates || []);

    // Combine all rates
    const allRates = [...(bankRates || []), ...botDeduped];

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
    const botCount = botDeduped.filter((r) => r.source === 'BOT').length;
    const bloombergCount = botDeduped.filter((r) => r.source === 'BLOOMBERG').length;

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
        botDate,
    };

    return NextResponse.json({
        date,
        botDate,
        rates: allRates,
        summary: [botBloombergSummary, ...bankSummaries],
    });
}

/**
 * Deduplicate rates: if same (source, currency) exists for multiple dates,
 * keep the one with the latest rate_date
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deduplicateRates(rates: any[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any>();
    for (const r of rates) {
        const key = `${r.source}|${r.currency}`;
        const existing = map.get(key);
        if (!existing || r.rate_date > existing.rate_date) {
            map.set(key, r);
        }
    }
    return Array.from(map.values());
}

// trigger vercel deploy
