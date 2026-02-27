import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const maxDuration = 120; // seconds
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const authHeader = request.headers.get('authorization');
    if (
        process.env.CRON_SECRET &&
        authHeader !== `Bearer ${process.env.CRON_SECRET}`
    ) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

    if (!supabaseUrl || !supabaseKey) {
        return NextResponse.json({ error: 'Missing Supabase Config' }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Fetch next year usually for the December cron, but for manual/initial run, default to 2026 or current year
    const url = new URL(request.url);
    const targetYear = url.searchParams.get('year') || new Date().getFullYear().toString();

    try {
        const botRes = await fetch(`https://apigw1.bot.or.th/bot/public/financial-institutions-holidays/?year=${targetYear}`, {
            headers: {
                'X-IBM-Client-Id': '2c1e8d1a-6d04-4df1-8da1-3de83b0daef4',
                'accept': 'application/json'
            }
        });

        if (!botRes.ok) {
            return NextResponse.json({ error: `BOT API responded with ${botRes.status}` }, { status: 502 });
        }

        const data = await botRes.json();
        const holidays = data.result?.data;

        if (!Array.isArray(holidays) || holidays.length === 0) {
            return NextResponse.json({ error: 'No data returned from BOT API' }, { status: 404 });
        }

        const inserts = holidays.map((item: any) => ({
            holiday_date: item.Date,
            description: item.HolidayDescriptionThai
        }));

        const { data: inserted, error } = await supabase
            .from('bank_holidays')
            .upsert(inserts, { onConflict: 'holiday_date' })
            .select();

        if (error) {
            throw new Error(error.message);
        }

        return NextResponse.json({
            success: true,
            year: targetYear,
            insertedRecords: inserted?.length || 0,
            records: inserted
        });

    } catch (err: any) {
        console.error('Holiday Sync Error:', err);
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}
