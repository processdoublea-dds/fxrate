import { NextResponse } from 'next/server';
import { supabaseAdmin, insertRates } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const {
      pin,
      source,
      sourceDate,
      targetDate
    } = await request.json();

    if (!pin || typeof pin !== 'string' || pin.length !== 4) {
      return NextResponse.json({ success: false, error: 'Invalid PIN format' }, { status: 400 });
    }

    if (!source || !sourceDate || !targetDate) {
      return NextResponse.json({ success: false, error: 'Missing source, sourceDate, or targetDate' }, { status: 400 });
    }

    // Get client info for audit log
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    // Verify PIN against active PINs
    const { data: pinData, error: pinError } = await supabaseAdmin
      .from('action_pins')
      .select('id, label')
      .eq('pin_code', pin)
      .eq('is_active', true)
      .limit(1);

    if (pinError) {
      console.error('PIN verification error in clone-rates:', pinError);
      return NextResponse.json({ success: false, error: 'PIN Verification failed' }, { status: 500 });
    }

    const valid = pinData && pinData.length > 0;
    const pinRecord = valid ? pinData[0] : null;
    const actionLabel = `Carry forward ${source} rates from ${sourceDate} to ${targetDate}`;

    // Log PIN attempt
    try {
      await supabaseAdmin.from('action_pin_logs').insert({
        pin_id: pinRecord?.id || null,
        pin_label: pinRecord?.label || null,
        action_label: actionLabel,
        result: valid ? 'success' : 'failed',
        attempted_pin: valid ? null : pin,
        ip_address: ip,
        user_agent: userAgent,
      });
    } catch (logErr) {
      console.error('Failed to log PIN attempt in clone-rates:', logErr);
    }

    if (!valid) {
      return NextResponse.json({ success: false, error: 'Incorrect PIN' }, { status: 401 });
    }

    // Fetch rates for source on sourceDate
    // For source = 'BOT', we should fetch both 'BOT' and 'BLOOMBERG' sources because BLOOMBERG is displayed as BOT in dashboard
    const sourcesToFetch = source === 'BOT' ? ['BOT', 'BLOOMBERG'] : [source];

    const { data: sourceRates, error: fetchRatesError } = await supabaseAdmin
      .from('exchange_rates')
      .select('*')
      .in('source', sourcesToFetch)
      .eq('rate_date', sourceDate);

    if (fetchRatesError) {
      console.error('Failed to fetch source rates for cloning:', fetchRatesError);
      return NextResponse.json({ success: false, error: 'Failed to fetch source rates' }, { status: 500 });
    }

    if (!sourceRates || sourceRates.length === 0) {
      return NextResponse.json({
        success: false,
        error: `No rates found for ${source} on ${sourceDate} to carry forward.`
      }, { status: 400 });
    }

    // Create a new run_id
    const runId = crypto.randomUUID();
    const nowStr = new Date().toISOString();

    // Map to new exchange rate inserts
    const ratesToInsert = sourceRates.map((r) => ({
      run_id: runId,
      rate_date: targetDate,
      source: r.source,
      currency: r.currency,
      currency_label: r.currency_label || '',
      sell_tt: r.sell_tt ?? undefined,
      sell_notes: r.sell_notes ?? undefined,
      buy_tt: r.buy_tt ?? undefined,
      buy_sight: r.buy_sight ?? undefined,
      buy_transfer: r.buy_transfer ?? undefined,
      buy_notes: r.buy_notes ?? undefined,
      mid_rate: r.mid_rate ?? undefined,
      bank_timestamp: r.bank_timestamp || nowStr,
      fetched_at: nowStr,
      raw_data: {
        cloned_from_date: sourceDate,
        cloned_at: nowStr,
        original_run_id: r.run_id
      }
    }));

    // Insert rates
    await insertRates(ratesToInsert);

    // Log in scrape_logs
    try {
      await supabaseAdmin.from('scrape_logs').insert({
        run_id: runId,
        source: `${source}_CARRY_FORWARD`,
        status: 'success',
        started_at: nowStr,
        completed_at: nowStr,
        records_count: ratesToInsert.length,
        duration_ms: 0,
        error_message: `Carried forward ${ratesToInsert.length} rates from ${sourceDate} to ${targetDate}`
      });
    } catch (scrapeLogErr) {
      console.error('Failed to log scrape log entry for clone-rates:', scrapeLogErr);
    }

    return NextResponse.json({ success: true, count: ratesToInsert.length });
  } catch (err) {
    console.error('Clone rates error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
