import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const { pin, actionLabel } = await request.json();

    if (!pin || typeof pin !== 'string' || pin.length !== 4) {
      return NextResponse.json({ valid: false, error: 'Invalid PIN format' }, { status: 400 });
    }

    // Get client info for audit log
    const forwarded = request.headers.get('x-forwarded-for');
    const ip = forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    // Verify PIN against active PINs
    const { data, error } = await supabaseAdmin
      .from('action_pins')
      .select('id, label')
      .eq('pin_code', pin)
      .eq('is_active', true)
      .limit(1);

    if (error) {
      console.error('PIN verification error:', error);
      return NextResponse.json({ valid: false, error: 'Verification failed' }, { status: 500 });
    }

    const valid = data && data.length > 0;
    const pinRecord = valid ? data[0] : null;

    // Log the attempt (success or failed)
    try {
      await supabaseAdmin.from('action_pin_logs').insert({
        pin_id: pinRecord?.id || null,
        pin_label: pinRecord?.label || null,
        action_label: actionLabel || 'unknown',
        result: valid ? 'success' : 'failed',
        attempted_pin: valid ? null : pin,
        ip_address: ip,
        user_agent: userAgent,
      });
    } catch (logErr) {
      // Don't fail the request if logging fails
      console.error('Failed to log PIN attempt:', logErr);
    }

    return NextResponse.json({ valid });
  } catch (err) {
    console.error('PIN verification error:', err);
    return NextResponse.json({ valid: false, error: 'Internal error' }, { status: 500 });
  }
}
