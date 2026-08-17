const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
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

const BOT_DATES_TO_FILL = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07', '2026-08-10'];

const FRIDAY_BLOOMBERG_SHIFTS = [
  { sundayDate: '2026-08-09', fridayDate: '2026-08-07' },
  { sundayDate: '2026-08-16', fridayDate: '2026-08-14' },
];

function parseNumber(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

async function main() {
  console.log('======================================================');
  console.log('🚀 Backfilling August 2026 BOT & Bloomberg Rates');
  console.log('======================================================\n');

  const runId = crypto.randomUUID();
  const nowStr = new Date().toISOString();

  // 1. Fetch missing BOT dates directly from BOT historical cache endpoint
  for (const dateStr of BOT_DATES_TO_FILL) {
    console.log(`📥 Fetching official BOT rates for ${dateStr}...`);
    const url = `https://www.bot.or.th/content/bot/th/statistics/exchange-rate/jcr:content/root/container/statisticstable2.results.level3cache.${dateStr}.json`;

    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json'
        },
        timeout: 10000
      });

      const items = res.data?.responseContent || [];
      if (items.length === 0) {
        console.warn(`   ⚠️ No items returned for ${dateStr}`);
        continue;
      }

      console.log(`   Fetched ${items.length} items from BOT for ${dateStr}`);

      const ratesToInsert = [];
      for (const item of items) {
        const currency = item.currency_id?.toUpperCase();
        if (!currency || currency === 'THB') continue;

        const sellRate = parseNumber(item.selling);
        const buySight = parseNumber(item.buying_sight);
        const buyTransfer = parseNumber(item.buying_transfer);

        ratesToInsert.push({
          run_id: runId,
          rate_date: dateStr,
          source: 'BOT',
          currency,
          currency_label: item.currency_name_th || item.currency_name_eng || currency,
          sell_tt: sellRate,
          sell_notes: sellRate,
          buy_tt: currency === 'USD' ? buySight : (buyTransfer ?? buySight),
          buy_sight: currency === 'USD' ? buySight : (buySight ?? buyTransfer),
          buy_transfer: currency === 'USD' ? buyTransfer : (buyTransfer ?? buySight),
          buy_notes: currency === 'USD' ? buyTransfer : (buyTransfer ?? buySight),
          mid_rate: parseNumber(item.mid_rate),
          bank_timestamp: `${dateStr}T00:00:00.000Z`,
          fetched_at: nowStr,
          raw_data: {
            ...item,
            fetched_from_historical_cache: true
          }
        });
      }

      const { error: upsertErr } = await supabaseAdmin
        .from('exchange_rates')
        .upsert(ratesToInsert, { onConflict: 'rate_date,source,currency' });

      if (upsertErr) {
        console.error(`   ❌ Upsert failed for ${dateStr}:`, upsertErr.message);
      } else {
        console.log(`   ✅ Upserted ${ratesToInsert.length} BOT rates for ${dateStr}`);
      }
    } catch (err) {
      console.error(`   ❌ Error fetching for ${dateStr}:`, err.message);
    }
  }

  // 2. Shift Sunday Bloomberg rates for August (08-09 -> 08-07, 08-16 -> 08-14)
  console.log('\n📌 Shifting August Sunday Bloomberg rates to Friday...');
  for (const { sundayDate, fridayDate } of FRIDAY_BLOOMBERG_SHIFTS) {
    const { data: sundayRecords, error: fetchErr } = await supabaseAdmin
      .from('exchange_rates')
      .select('*')
      .eq('rate_date', sundayDate)
      .in('currency', ['BTN', 'MNT']);

    if (fetchErr || !sundayRecords || sundayRecords.length === 0) {
      console.warn(`   ⚠️ No Sunday records on ${sundayDate}`);
      continue;
    }

    const fridayRecords = sundayRecords.map(r => ({
      run_id: runId,
      rate_date: fridayDate,
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
      bank_timestamp: `${fridayDate}T00:00:00.000Z`,
      fetched_at: r.fetched_at || nowStr,
      raw_data: {
        ...(r.raw_data || {}),
        reassigned_from_sunday: sundayDate,
        reassigned_to_friday: fridayDate,
        reassigned_at: nowStr
      }
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from('exchange_rates')
      .upsert(fridayRecords, { onConflict: 'rate_date,source,currency' });

    if (upsertErr) {
      console.error(`   ❌ Upsert failed for Friday ${fridayDate}:`, upsertErr.message);
    } else {
      console.log(`   ✅ Upserted ${fridayRecords.length} records to Friday ${fridayDate}`);

      // Delete Sunday records
      await supabaseAdmin
        .from('exchange_rates')
        .delete()
        .eq('rate_date', sundayDate)
        .in('currency', ['BTN', 'MNT']);
      console.log(`   🗑️ Cleaned up orphan Sunday records on ${sundayDate}`);
    }
  }

  // 3. Verification of all business days in August 2026
  console.log('\n======================================================');
  console.log('🔍 AUGUST 2026 FINAL VERIFICATION');
  console.log('======================================================\n');

  const augustBusinessDays = [
    '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
    '2026-08-10', '2026-08-11', '2026-08-13', '2026-08-14'
  ];

  let allGood = true;
  for (const d of augustBusinessDays) {
    const { data: rates } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'BOT')
      .eq('rate_date', d);

    const count = rates ? rates.length : 0;
    const hasBtn = rates && rates.some(r => r.currency === 'BTN');
    const hasMnt = rates && rates.some(r => r.currency === 'MNT');
    const ok = count === 50 && hasBtn && hasMnt;
    if (!ok) allGood = false;

    console.log(`Date: ${d} -> Total: ${count} currencies (BTN: ${hasBtn ? '✅' : '❌'}, MNT: ${hasMnt ? '✅' : '❌'}) ${ok ? '✅ COMPLETE' : '❌'}`);
  }

  console.log(`\n🎉 August Status: ${allGood ? 'ALL AUGUST BUSINESS DAYS ARE 100% COMPLETE WITH 50 CURRENCIES! 🏆' : 'INCOMPLETE ⚠️'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
