import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

/**
 * Public REST API — Export exchange rates as JSON
 * 
 * Usage:
 *   GET /api/export              → returns today's rates (Bangkok time)
 *   GET /api/export?date=2026-02-19  → returns rates for specific date
 * 
 * Response matches the legacy AppScript format:
 * {
 *   "status": "success",
 *   "message": "Returned N records",
 *   "data": [{ bank, currency, sell_tt, sell_notes, buy_tt, buy_sight, buy_transfer, buy_notes, currency_web, timestamp_bank }]
 * }
 */

function getPreviousBusinessDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() - 1);
    }
    return d.toISOString().split('T')[0];
}

function formatTimestamp(ts: string | null): string {
    if (!ts) return '';
    try {
        const d = new Date(ts);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const hh = String(d.getHours()).padStart(2, '0');
        const mi = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
    } catch {
        return ts;
    }
}

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date') || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });

    // BOT + Bloomberg use previous business date
    const botDate = getPreviousBusinessDate(date);

    // Fetch Thai bank rates (SCB, KTB, KBANK) for the requested date
    const { data: bankRates, error: bankError } = await supabaseAdmin
        .from('exchange_rates')
        .select('source, currency, currency_label, sell_tt, sell_notes, buy_tt, buy_sight, buy_transfer, buy_notes, bank_timestamp')
        .eq('rate_date', date)
        .in('source', ['SCB', 'KTB', 'KBANK'])
        .order('source')
        .order('currency');

    if (bankError) {
        return NextResponse.json(
            { status: 'error', message: bankError.message, data: [] },
            { status: 500, headers: corsHeaders() }
        );
    }

    // Fetch BOT + Bloomberg rates (check both dates)
    const { data: botRates, error: botError } = await supabaseAdmin
        .from('exchange_rates')
        .select('source, currency, currency_label, sell_tt, sell_notes, buy_tt, buy_sight, buy_transfer, buy_notes, bank_timestamp')
        .in('rate_date', [date, botDate])
        .in('source', ['BOT', 'BLOOMBERG'])
        .order('source')
        .order('currency');

    if (botError) {
        return NextResponse.json(
            { status: 'error', message: botError.message, data: [] },
            { status: 500, headers: corsHeaders() }
        );
    }

    // Deduplicate BOT/Bloomberg (prefer latest date)
    const botDeduped = deduplicateRates(botRates || []);

    // Combine and format
    const allRates = [...(bankRates || []), ...botDeduped];

    // Sort: SCB → KTB → KBANK → BOT → BLOOMBERG, then by currency
    const sourceOrder: Record<string, number> = { SCB: 1, KTB: 2, KBANK: 3, BOT: 4, BLOOMBERG: 5 };
    allRates.sort((a, b) => {
        const orderDiff = (sourceOrder[a.source] || 99) - (sourceOrder[b.source] || 99);
        if (orderDiff !== 0) return orderDiff;
        return a.currency.localeCompare(b.currency);
    });

    // Map to AppScript-compatible format
    const data = allRates.map((r) => ({
        bank: r.source === 'BLOOMBERG' ? 'BOT' : r.source,
        currency: r.currency,
        sell_tt: r.sell_tt ?? 0,
        sell_notes: r.sell_notes ?? 0,
        buy_tt: r.buy_tt ?? 0,
        buy_sight: r.buy_sight ?? 0,
        buy_transfer: r.buy_transfer ?? 0,
        buy_notes: r.buy_notes ?? 0,
        currency_web: r.currency_label || r.currency,
        timestamp_bank: formatTimestamp(r.bank_timestamp),
    }));

    return NextResponse.json(
        {
            status: 'success',
            message: `Returned ${data.length} records`,
            data,
        },
        { headers: corsHeaders() }
    );
}

/** CORS headers for cross-origin access */
function corsHeaders(): HeadersInit {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'public, max-age=300, s-maxage=300',
    };
}

/** Handle CORS preflight */
export async function OPTIONS() {
    return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

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
