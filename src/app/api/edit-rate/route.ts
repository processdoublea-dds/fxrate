import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const {
      pin,
      id,
      sell_tt,
      sell_notes,
      buy_tt,
      buy_sight,
      buy_transfer,
      buy_notes
    } = await request.json();

    if (!pin || typeof pin !== 'string' || pin.length !== 4) {
      return NextResponse.json({ success: false, error: 'Invalid PIN format' }, { status: 400 });
    }

    if (!id) {
      return NextResponse.json({ success: false, error: 'Missing rate ID' }, { status: 400 });
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
      console.error('PIN verification error in edit-rate:', pinError);
      return NextResponse.json({ success: false, error: 'PIN Verification failed' }, { status: 500 });
    }

    const valid = pinData && pinData.length > 0;
    const pinRecord = valid ? pinData[0] : null;
    const actionLabel = `Manual rate edit for ID ${id}`;

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
      console.error('Failed to log PIN attempt in edit-rate:', logErr);
    }

    if (!valid) {
      return NextResponse.json({ success: false, error: 'Incorrect PIN' }, { status: 401 });
    }

    // Fetch the existing rate to see the source/currency for the audit log
    const { data: existingRate, error: fetchRateError } = await supabaseAdmin
      .from('exchange_rates')
      .select('source, currency, rate_date')
      .eq('id', id)
      .single();

    if (fetchRateError || !existingRate) {
      return NextResponse.json({ success: false, error: 'Rate record not found' }, { status: 404 });
    }

    // Parse rate fields (ensure numbers or nulls)
    const parseRate = (val: any) => {
      if (val === null || val === undefined || val === '') return null;
      const num = parseFloat(val);
      return isNaN(num) ? null : num;
    };

    // Update the exchange rate row
    const updatePayload = {
      sell_tt: parseRate(sell_tt),
      sell_notes: parseRate(sell_notes),
      buy_tt: parseRate(buy_tt),
      buy_sight: parseRate(buy_sight),
      buy_transfer: parseRate(buy_transfer),
      buy_notes: parseRate(buy_notes),
      fetched_at: new Date().toISOString()
    };

    const { error: updateError } = await supabaseAdmin
      .from('exchange_rates')
      .update(updatePayload)
      .eq('id', id);

    if (updateError) {
      console.error('Failed to update rate record:', updateError);
      return NextResponse.json({ success: false, error: 'Failed to update rate in database' }, { status: 500 });
    }

    // Log the manual edit in scrape_logs
    try {
      await supabaseAdmin.from('scrape_logs').insert({
        run_id: crypto.randomUUID(),
        source: `${existingRate.source}_MANUAL_EDIT`,
        status: 'success',
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        records_count: 1,
        duration_ms: 0,
        error_message: `Manual edit of currency ${existingRate.currency} on date ${existingRate.rate_date}`
      });
    } catch (scrapeLogErr) {
      console.error('Failed to log scrape log entry for edit-rate:', scrapeLogErr);
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Edit rate error:', err);
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
  }
}
