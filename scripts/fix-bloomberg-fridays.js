const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env.local');
  process.exit(1);
}

const supabaseAdmin = createClient(supabaseUrl, supabaseKey);

// Mapping from Sunday (when Monday scraper erroneously saved) to Friday (the actual business date)
const DATE_MAPPING = [
  { sundayDate: '2026-07-05', targetFridayDate: '2026-07-03' },
  { sundayDate: '2026-07-12', targetFridayDate: '2026-07-10' },
  { sundayDate: '2026-07-19', targetFridayDate: '2026-07-17' },
  { sundayDate: '2026-07-26', targetFridayDate: '2026-07-24' },
  { sundayDate: '2026-08-02', targetFridayDate: '2026-07-31' },
];

async function main() {
  console.log('====================================================');
  console.log('🚀 Fixing Bloomberg BTN/MNT Rates for Missing Fridays');
  console.log('====================================================\n');

  const runId = crypto.randomUUID();
  const nowStr = new Date().toISOString();

  for (const { sundayDate, targetFridayDate } of DATE_MAPPING) {
    console.log(`📌 Processing Sunday ${sundayDate} -> Friday ${targetFridayDate}...`);

    // 1. Fetch BTN/MNT from Sunday date
    const { data: sundayRecords, error: fetchErr } = await supabaseAdmin
      .from('exchange_rates')
      .select('*')
      .eq('rate_date', sundayDate)
      .in('currency', ['BTN', 'MNT']);

    if (fetchErr) {
      console.error(`   ❌ Failed to fetch from ${sundayDate}:`, fetchErr.message);
      continue;
    }

    if (!sundayRecords || sundayRecords.length === 0) {
      console.warn(`   ⚠️ No Sunday records found on ${sundayDate}`);
      continue;
    }

    console.log(`   Found ${sundayRecords.length} records on ${sundayDate}: ${sundayRecords.map(r => `${r.currency}=${r.sell_tt}`).join(', ')}`);

    // 2. Prepare Friday records
    const fridayRecords = sundayRecords.map(r => ({
      run_id: runId,
      rate_date: targetFridayDate,
      source: 'BOT',
      currency: r.currency,
      currency_label: r.currency_label || (r.currency === 'BTN' ? 'Bhutanese Ngultrum' : 'Mongolian Tughrik'),
      sell_tt: r.sell_tt,
      sell_notes: r.sell_notes,
      buy_tt: r.buy_tt,
      buy_sight: r.buy_sight,
      buy_transfer: r.buy_transfer,
      buy_notes: r.buy_notes,
      mid_rate: r.mid_rate,
      bank_timestamp: `${targetFridayDate}T00:00:00.000Z`,
      fetched_at: r.fetched_at || nowStr,
      raw_data: {
        ...(r.raw_data || {}),
        reassigned_from_sunday: sundayDate,
        reassigned_to_friday: targetFridayDate,
        reassigned_at: nowStr
      }
    }));

    // 3. Upsert to Friday
    const { error: upsertErr } = await supabaseAdmin
      .from('exchange_rates')
      .upsert(fridayRecords, { onConflict: 'rate_date,source,currency' });

    if (upsertErr) {
      console.error(`   ❌ Failed to upsert to ${targetFridayDate}:`, upsertErr.message);
    } else {
      console.log(`   ✅ Upserted ${fridayRecords.length} records to Friday ${targetFridayDate}`);

      // 4. Delete orphan Sunday records
      const { error: delErr } = await supabaseAdmin
        .from('exchange_rates')
        .delete()
        .eq('rate_date', sundayDate)
        .in('currency', ['BTN', 'MNT']);

      if (delErr) {
        console.error(`   ⚠️ Failed to delete Sunday records on ${sundayDate}:`, delErr.message);
      } else {
        console.log(`   🗑️ Cleaned up orphan Sunday records on ${sundayDate}`);
      }
    }
  }

  // 5. Verification across all 22 July business days
  console.log('\n====================================================');
  console.log('🔍 FINAL VERIFICATION FOR ALL 22 BUSINESS DAYS');
  console.log('====================================================\n');

  const allBusinessDays = [
    '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03',
    '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09',
    '2026-07-10', '2026-07-13', '2026-07-14', '2026-07-15',
    '2026-07-16', '2026-07-17', '2026-07-20', '2026-07-21',
    '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-27',
    '2026-07-30', '2026-07-31'
  ];

  let all50 = true;
  for (const d of allBusinessDays) {
    const { data: rates } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'BOT')
      .eq('rate_date', d);

    const count = rates ? rates.length : 0;
    const hasBtn = rates && rates.some(r => r.currency === 'BTN');
    const hasMnt = rates && rates.some(r => r.currency === 'MNT');
    const ok = count === 50 && hasBtn && hasMnt;
    if (!ok) all50 = false;
    console.log(`Date: ${d} -> Total: ${count} currencies (BTN: ${hasBtn ? '✅' : '❌'}, MNT: ${hasMnt ? '✅' : '❌'}) ${ok ? '✅ COMPLETE' : '❌'}`);
  }

  console.log(`\n🎉 Overall Status: ${all50 ? 'ALL 22 DAYS NOW HAVE EXACTLY 50 CURRENCIES (48 BOT + 2 BLOOMBERG) 🏆' : 'INCOMPLETE ⚠️'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
