/**
 * Patch script to divide existing BOT VND rates by 100 in Supabase.
 * BOT quotes VND per 100 units (100 Dong).
 * This script ensures all historical records represent the rate per 1 unit.
 * 
 * Safe and idempotent: records already < 0.01 will be skipped.
 */

const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Missing Supabase credentials in app/.env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function adjust(val) {
  if (val === null || val === undefined) return val;
  return Math.round((Number(val) / 100) * 100000000) / 100000000;
}

async function run() {
  console.log('====================================================');
  console.log('🔄 Patching BOT VND rates (divide by 100 in Supabase)');
  console.log('====================================================\n');

  const { data: records, error } = await supabase
    .from('exchange_rates')
    .select('*')
    .eq('source', 'BOT')
    .eq('currency', 'VND')
    .gte('rate_date', '2026-07-01')
    .order('rate_date', { ascending: true });

  if (error) {
    console.error('❌ Error fetching records:', error.message);
    return;
  }

  console.log(`📊 Found total ${records.length} BOT records for VND since 2026-07-01.`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const record of records) {
    // Check threshold: normal 100 VND is ~0.12 - 0.13.
    // If already divided by 100, VND is ~0.0012 - 0.0013 (< 0.05).
    const checkVal = record.sell_tt ?? record.buy_tt ?? record.buy_transfer ?? record.sell_notes;
    if (checkVal !== null && checkVal !== undefined) {
      if (checkVal < 0.05) {
        skippedCount++;
        continue;
      }
    }

    const updates = {
      sell_tt: adjust(record.sell_tt),
      sell_notes: adjust(record.sell_notes),
      buy_tt: adjust(record.buy_tt),
      buy_sight: adjust(record.buy_sight),
      buy_transfer: adjust(record.buy_transfer),
      buy_notes: adjust(record.buy_notes),
      mid_rate: adjust(record.mid_rate),
    };

    const { error: updateErr } = await supabase
      .from('exchange_rates')
      .update(updates)
      .eq('id', record.id);

    if (updateErr) {
      console.error(`❌ Failed to update ID ${record.id} (${record.currency} on ${record.rate_date}):`, updateErr.message);
    } else {
      updatedCount++;
    }
  }

  console.log(`\n✅ Finished patching Supabase:`);
  console.log(`   - Updated: ${updatedCount} records`);
  console.log(`   - Skipped (already divided): ${skippedCount} records`);

  // Verify sample results
  const { data: samples } = await supabase
    .from('exchange_rates')
    .select('rate_date, currency, sell_tt, buy_transfer, mid_rate')
    .eq('source', 'BOT')
    .eq('currency', 'VND')
    .gte('rate_date', '2026-07-01')
    .order('rate_date', { ascending: false })
    .limit(5);

  console.log('\n🔍 Sample updated records in Supabase (latest):');
  console.table(samples);
}

run().catch(console.error);
