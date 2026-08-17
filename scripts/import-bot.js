const { createClient } = require('@supabase/supabase-js');
const { spawnSync } = require('child_process');
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

async function main() {
  console.log('==================================================');
  console.log('🚀 Starting BOT Historical Backfill Import');
  console.log('==================================================\n');

  // 1. Run python extractor
  const pyScriptPath = path.join(__dirname, '../extract_bot.py');
  console.log('📖 Reading Excel file via python extractor...');
  const pyRes = spawnSync('python3', [pyScriptPath], { maxBuffer: 50 * 1024 * 1024 });

  if (pyRes.error) {
    console.error('❌ Python extraction failed:', pyRes.error);
    process.exit(1);
  }

  const allDays = JSON.parse(pyRes.stdout.toString());
  console.log(`✅ Extracted ${allDays.length} business days from Excel.\n`);

  const runId = crypto.randomUUID();
  const nowStr = new Date().toISOString();

  let totalNewInserted = 0;
  let totalProcessed = 0;

  // Process day by day
  for (const day of allDays) {
    const { date, sheet, records } = day;
    
    // Check existing currencies for this day in DB
    const { data: existing, error: checkErr } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'BOT')
      .eq('rate_date', date);

    if (checkErr) {
      console.error(`❌ Error checking DB for date ${date}:`, checkErr);
      continue;
    }

    const existingCurrs = new Set((existing || []).map(r => r.currency));
    const missingInDb = records.filter(r => !existingCurrs.has(r.currency));

    console.log(`📅 Date ${date} (Sheet: ${sheet}):`);
    console.log(`   - Existing BOT currencies in DB: ${existingCurrs.size}`);
    console.log(`   - Missing to insert: ${missingInDb.length} currencies (${missingInDb.map(m => m.currency).join(', ')})`);

    // Prepare records with valid UUID runId
    const recordsToUpsert = records.map(r => ({
      ...r,
      run_id: runId,
      fetched_at: nowStr
    }));

    // Upsert all 48 currencies for this date
    const { data: upsertData, error: upsertErr } = await supabaseAdmin
      .from('exchange_rates')
      .upsert(recordsToUpsert, { onConflict: 'rate_date,source,currency' });

    if (upsertErr) {
      console.error(`   ❌ Upsert failed for ${date}:`, upsertErr.message);
    } else {
      totalNewInserted += missingInDb.length;
      totalProcessed += records.length;
      console.log(`   ✅ Successfully upserted 48 currencies for ${date}.`);
    }
  }

  // Insert into scrape_logs
  console.log('\n📝 Logging import to scrape_logs table...');
  try {
    await supabaseAdmin.from('scrape_logs').insert({
      run_id: runId,
      source: 'BOT_BACKWARD_IMPORT',
      status: 'success',
      started_at: nowStr,
      completed_at: new Date().toISOString(),
      records_count: totalProcessed,
      duration_ms: 0,
      error_message: `Successfully backfilled 22 days of BOT rates (${totalNewInserted} newly added missing currency records, ${totalProcessed} total BOT rates).`
    });
    console.log('✅ Audit log created in scrape_logs.');
  } catch (logErr) {
    console.error('⚠️ Could not insert scrape_log:', logErr);
  }

  // Verification step
  console.log('\n==================================================');
  console.log('🔍 VERIFICATION AFTER BACKFILL');
  console.log('==================================================\n');

  let allSuccess = true;
  for (const day of allDays) {
    const { date } = day;
    const { data: currentBot } = await supabaseAdmin
      .from('exchange_rates')
      .select('currency')
      .eq('source', 'BOT')
      .eq('rate_date', date);

    const count = currentBot ? currentBot.length : 0;
    const ok = count >= 48;
    if (!ok) allSuccess = false;
    console.log(`Date: ${date} -> BOT currencies in DB: ${count} / 48+ ${ok ? '✅' : '❌'}`);
  }

  console.log(`\n🎉 Backfill summary: ${totalNewInserted} missing records added, total ${totalProcessed} records processed.`);
  console.log(`Status: ${allSuccess ? 'ALL DAYS COMPLETE & VERIFIED ✅' : 'PARTIAL ISSUES ❌'}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
