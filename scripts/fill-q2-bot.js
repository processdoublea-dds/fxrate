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

function parseNumber(val) {
  if (val === null || val === undefined || val === '' || val === '-') return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

// Sunday -> Friday mapping for Bloomberg BTN/MNT in April, May, June 2026
const BLOOMBERG_SHIFTS = [
  { sundayDate: '2026-04-05', targetDate: '2026-04-03' },
  { sundayDate: '2026-04-12', targetDate: '2026-04-10' },
  { sundayDate: '2026-04-19', targetDate: '2026-04-17' },
  { sundayDate: '2026-04-26', targetDate: '2026-04-24' },
  { sundayDate: '2026-05-03', targetDate: '2026-04-30' }, // May 1 was holiday, April 30 was Thu
  { sundayDate: '2026-05-10', targetDate: '2026-05-08' },
  { sundayDate: '2026-05-17', targetDate: '2026-05-15' },
  { sundayDate: '2026-05-24', targetDate: '2026-05-22' },
  { sundayDate: '2026-05-31', targetDate: '2026-05-29' },
  { sundayDate: '2026-06-07', targetDate: '2026-06-05' },
  { sundayDate: '2026-06-14', targetDate: '2026-06-12' },
  { sundayDate: '2026-06-21', targetDate: '2026-06-19' },
  { sundayDate: '2026-06-28', targetDate: '2026-06-26' },
];

async function main() {
  console.log('===============================================================');
  console.log('🚀 Backfilling April, May, and June (1-29) 2026 BOT & Bloomberg');
  console.log('===============================================================\n');

  const runId = crypto.randomUUID();
  const nowStr = new Date().toISOString();

  // 1. Generate all calendar dates from 2026-04-01 to 2026-06-29 (weekdays only)
  const startDate = new Date('2026-04-01T00:00:00Z');
  const endDate = new Date('2026-06-29T00:00:00Z');
  const weekdayDates = [];

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dayOfWeek = d.getUTCDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) { // Skip Sat & Sun
      weekdayDates.push(d.toISOString().split('T')[0]);
    }
  }

  console.log(`📅 Found ${weekdayDates.length} weekdays in range 2026-04-01 to 2026-06-29.\n`);

  let totalBotUpserted = 0;

  // 2. Fetch and upsert BOT rates for each date
  for (const dateStr of weekdayDates) {
    const url = `https://www.bot.or.th/content/bot/th/statistics/exchange-rate/jcr:content/root/container/statisticstable2.results.level3cache.${dateStr}.json`;

    try {
      const res = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json'
        },
        timeout: 8000
      });

      // Check if BOT returned data (or if it was a holiday)
      const items = res.data?.responseContent || [];
      if (items.length === 0 || res.data?.noDataFoundFlag === 'Y') {
        console.log(`🏖️ Date ${dateStr}: No BOT rate published (likely Bank Holiday).`);
        continue;
      }

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

      if (ratesToInsert.length > 0) {
        const { error: upsertErr } = await supabaseAdmin
          .from('exchange_rates')
          .upsert(ratesToInsert, { onConflict: 'rate_date,source,currency' });

        if (upsertErr) {
          console.error(`   ❌ Upsert failed for ${dateStr}:`, upsertErr.message);
        } else {
          totalBotUpserted += ratesToInsert.length;
          console.log(`   ✅ Date ${dateStr}: Upserted ${ratesToInsert.length} BOT rates.`);
        }
      }
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`🏖️ Date ${dateStr}: 404 not found (Bank Holiday).`);
      } else {
        console.error(`   ❌ Error fetching BOT for ${dateStr}:`, err.message);
      }
    }
  }

  // 3. Shift Sunday Bloomberg rates to Friday
  console.log('\n📌 Shifting Bloomberg BTN/MNT rates from Sunday to Friday...');
  for (const { sundayDate, targetDate } of BLOOMBERG_SHIFTS) {
    const { data: sundayRecords, error: fetchErr } = await supabaseAdmin
      .from('exchange_rates')
      .select('*')
      .eq('rate_date', sundayDate)
      .in('currency', ['BTN', 'MNT']);

    if (fetchErr || !sundayRecords || sundayRecords.length === 0) {
      console.warn(`   ⚠️ No Sunday records on ${sundayDate}`);
      continue;
    }

    const targetRecords = sundayRecords.map(r => ({
      run_id: runId,
      rate_date: targetDate,
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
      bank_timestamp: `${targetDate}T00:00:00.000Z`,
      fetched_at: r.fetched_at || nowStr,
      raw_data: {
        ...(r.raw_data || {}),
        reassigned_from_sunday: sundayDate,
        reassigned_to_target: targetDate,
        reassigned_at: nowStr
      }
    }));

    const { error: upsertErr } = await supabaseAdmin
      .from('exchange_rates')
      .upsert(targetRecords, { onConflict: 'rate_date,source,currency' });

    if (upsertErr) {
      console.error(`   ❌ Failed to upsert ${targetDate}:`, upsertErr.message);
    } else {
      console.log(`   ✅ Shifted ${targetRecords.length} Bloomberg records (${sundayDate} -> ${targetDate})`);

      // Delete Sunday records
      await supabaseAdmin
        .from('exchange_rates')
        .delete()
        .eq('rate_date', sundayDate)
        .in('currency', ['BTN', 'MNT']);
      console.log(`   🗑️ Deleted orphan Sunday records on ${sundayDate}`);
    }
  }

  // 4. Log in scrape_logs
  console.log('\n📝 Logging to scrape_logs table...');
  try {
    await supabaseAdmin.from('scrape_logs').insert({
      run_id: runId,
      source: 'BOT_Q2_BACKWARD_IMPORT',
      status: 'success',
      started_at: nowStr,
      completed_at: new Date().toISOString(),
      records_count: totalBotUpserted,
      duration_ms: 0,
      error_message: `Backfilled April, May, and June (1-29) 2026. Total ${totalBotUpserted} BOT rates upserted and Bloomberg Friday rates shifted.`
    });
    console.log('✅ Audit log created in scrape_logs.');
  } catch (logErr) {
    console.error('⚠️ Could not insert scrape_log:', logErr);
  }

  // 5. Verification
  console.log('\n===============================================================');
  console.log('🔍 VERIFICATION FOR APRIL, MAY, AND JUNE (1-29) 2026');
  console.log('===============================================================\n');

  let allCompleted = true;
  for (const dateStr of weekdayDates) {
    // Check if holiday
    const { data: holidayData } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'Bank Holiday System')
      .eq('rate_date', dateStr);

    const isHoliday = holidayData && holidayData.length > 0;

    const { data: rates } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'BOT')
      .eq('rate_date', dateStr);

    const count = rates ? rates.length : 0;
    const hasBtn = rates && rates.some(r => r.currency === 'BTN');
    const hasMnt = rates && rates.some(r => r.currency === 'MNT');

    if (isHoliday) {
      console.log(`Date ${dateStr}: 🏖️ BANK HOLIDAY (${holidayData[0].currency})`);
    } else if (count >= 48) {
      console.log(`Date ${dateStr}: Total=${count} currs (BTN: ${hasBtn ? '✅' : '❌'}, MNT: ${hasMnt ? '✅' : '❌'}) ${count === 50 ? '✅ 50/50 COMPLETE' : '⚠️ BOT 48'}`);
    } else {
      allCompleted = false;
      console.log(`Date ${dateStr}: Total=${count} currs ❌ INCOMPLETE`);
    }
  }

  console.log(`\n🎉 Backfill summary: Total ${totalBotUpserted} BOT rates processed.`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
