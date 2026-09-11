/**
 * Apply SQL Server changes for FX Rate views and master table
 * 1. Update dbo.currency_master: is_avg = 'Y' for 22 currencies
 * 2. Alter dbo.vw_FxRate_AVG: combine 3 Thai Banks + 22 BOT currencies shifted to Date T
 * 3. Patch dbo.exrate: divide KHR and LAK by 100 (if > 0.05)
 * 4. Verify results
 */

const fs = require('fs');
const path = require('path');
const { Connection, Request } = require('tedious');

const envPath = path.resolve(__dirname, '../.env.local');
const content = fs.readFileSync(envPath, 'utf-8');
const lines = content.split('\n');

let host = '203.150.86.17';
let user = '';
let pass = '';
let db = 'process_team';

let isDb = false;
for (const line of lines) {
  const t = line.trim();
  if (t.startsWith('ADDRESS_MYGREEN')) host = t.split('=')[1].replace(/[\"']/g, '').trim();
  if (t.includes('Database raw price')) { isDb = true; continue; }
  if (isDb && t && !t.startsWith('#')) {
    const parts = t.split('=');
    const k = parts[0].trim();
    const v = parts.slice(1).join('=').replace(/[\"']/g, '').trim();
    if (k === 'USER') user = v;
    if (k === 'PASS') pass = v;
    if (k === 'DB_NAME') db = v;
  }
}

const config = {
  server: host,
  authentication: {
    type: 'default',
    options: { userName: user, password: pass }
  },
  options: {
    encrypt: false,
    database: db,
    trustServerCertificate: true,
    connectTimeout: 15000,
    requestTimeout: 30000
  }
};

const conn = new Connection(config);

function exec(sql, label) {
  return new Promise((resolve, reject) => {
    console.log(`⏳ Executing: ${label}...`);
    const req = new Request(sql, (err, rowCount) => {
      if (err) {
        console.error(`❌ Error in ${label}:`, err.message);
        return reject(err);
      }
      console.log(`✅ Success: ${label} (Affected rows: ${rowCount})`);
      resolve(rowCount);
    });
    conn.execSql(req);
  });
}

function query(sql) {
  return new Promise((resolve, reject) => {
    const req = new Request(sql, (err) => {
      if (err) return reject(err);
    });
    const rows = [];
    req.on('row', (cols) => {
      const row = {};
      for (const col of cols) {
        row[col.metadata.colName] = col.value;
      }
      rows.push(row);
    });
    req.on('requestCompleted', () => resolve(rows));
    conn.execSql(req);
  });
}

async function main() {
  console.log('===============================================================');
  console.log('🚀 Applying SQL Server Updates (process_team @ ' + host + ')');
  console.log('===============================================================\n');

  // Step 1: Update dbo.currency_master
  const sqlUpdateMaster = `
UPDATE [dbo].[currency_master]
SET is_avg = 'Y'
WHERE currency_name IN (
    'MXN', 'KWD', 'MMK', 'BDT', 'CZK', 'KHR', 'KES', 'LAK', 'RUB',
    'EGP', 'PLN', 'LKR', 'IQD', 'JOD', 'QAR', 'MVR', 'NPR', 'ILS',
    'HUF', 'PKR', 'BTN', 'MNT'
);
`;
  await exec(sqlUpdateMaster, 'Step 1: Update currency_master (set is_avg = Y)');

  // Step 2: Patch KHR and LAK in dbo.exrate (divide by 100 if > 0.05)
  const sqlPatchKhrLak = `
UPDATE [dbo].[exrate]
SET 
    sell_tt = ROUND(sell_tt / 100.0, 5),
    sell_notes = ROUND(sell_notes / 100.0, 5),
    buy_tt = ROUND(buy_tt / 100.0, 5),
    buy_sight = ROUND(buy_sight / 100.0, 5),
    buy_transfer = ROUND(buy_transfer / 100.0, 5),
    buy_notes = ROUND(buy_notes / 100.0, 5)
WHERE currency IN ('KHR', 'LAK')
  AND (sell_tt > 0.05 OR buy_transfer > 0.05 OR sell_notes > 0.05);
`;
  await exec(sqlPatchKhrLak, 'Step 2: Patch KHR & LAK in dbo.exrate (/100)');

  // Step 3: Alter View dbo.vw_FxRate_AVG
  const sqlAlterViewAvg = `
ALTER VIEW [dbo].[vw_FxRate_AVG]
AS
-- 1. ชุดวันที่ทั้งหมดที่มีเรทของ 3 ธนาคารไทย (BankDate = วันที่ T) พร้อม updated_date ประจำรอบ
WITH thai_dates AS (
    SELECT
        CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
            ) AS date
        ) AS BankDate,
        MAX(rf.updated_date) AS updated_date
    FROM dbo.exrate AS rf
    WHERE rf.bank_name IN ('SCB', 'KTB', 'KBANK')
    GROUP BY CAST(
        COALESCE(
            DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
            DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
        ) AS date
    )
),

-- 2. ข้อมูลกลุ่มที่ 1: เฉลี่ย 3 ธนาคารไทย (เฉพาะ 27 สกุลเงินหลัก cm.currency_type = 'AVG')
thai_base AS (
    SELECT
        rf.currency,
        rf.timestamp_bank,
        rf.updated_date,
        CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
            ) AS date
        ) AS BankDate,
        NULLIF(rf.buy_notes,    0) AS buy_notes,
        NULLIF(rf.buy_transfer, 0) AS buy_transfer,
        NULLIF(rf.buy_tt,       0) AS buy_tt,
        NULLIF(rf.sell_tt,      0) AS sell_tt,
        NULLIF(rf.sell_notes,   0) AS sell_notes
    FROM dbo.exrate AS rf
    INNER JOIN dbo.currency_master cm ON rf.currency = cm.currency_name
    WHERE rf.bank_name IN ('SCB', 'KTB', 'KBANK')
      AND cm.currency_type = 'AVG'
),
thai_agg AS (
    SELECT
        currency,
        BankDate,
        MAX(timestamp_bank) AS timestamp_bank,
        MAX(updated_date)   AS updated_date,
        -- BUY: 18 สกุลเงินหลักใช้ buy_tt (หรือ buy_notes), สกุลเงินอื่นๆ (BHD, ZAR, OMR, BND, etc.) ใช้ buy_notes (หรือ buy_tt)
        CASE
            WHEN currency IN (
                'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
                'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
            )
            THEN COALESCE(AVG(buy_tt), AVG(buy_notes), AVG(buy_transfer))
            ELSE COALESCE(AVG(buy_notes), AVG(buy_tt), AVG(buy_transfer))
        END AS avg_buy,
        -- SELL: 18 สกุลเงินหลักใช้ sell_tt (หรือ sell_notes), สกุลเงินอื่นๆ ใช้ sell_notes (หรือ sell_tt)
        CASE
            WHEN currency IN (
                'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
                'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
            )
            THEN COALESCE(AVG(sell_tt), AVG(sell_notes))
            ELSE COALESCE(AVG(sell_notes), AVG(sell_tt))
        END AS avg_sell
    FROM thai_base
    GROUP BY currency, BankDate
),

-- 3. ข้อมูลกลุ่มที่ 2: 22 สกุลเงิน BOT/Bloomberg โดย Shift วันที่ให้ตรงกับ BankDate ของ Thai Banks
bot_shifted AS (
    SELECT
        td.BankDate,
        cm.currency_name AS currency,
        b.timestamp_bank,
        td.updated_date,     -- 👈 ให้ updated_date ตรงกับรอบวันของ Thai Banks เสมอ
        b.buy_transfer   AS avg_buy,
        b.sell_notes     AS avg_sell
    FROM thai_dates td
    CROSS JOIN dbo.currency_master cm
    CROSS APPLY (
        SELECT TOP 1
            rf.buy_transfer,
            rf.sell_notes,
            rf.timestamp_bank,
            rf.updated_date
        FROM dbo.exrate rf
        WHERE rf.bank_name IN ('BOT', 'BLOOMBERG')
          AND rf.currency = cm.currency_name
          -- เรท BOT ที่ประกาศก่อนวันของ Thai Bank (T-1)
          AND CAST(
                COALESCE(
                    DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
                    DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
                ) AS date
              ) < td.BankDate
        ORDER BY CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
            ) AS date
        ) DESC
    ) b
    WHERE cm.currency_name IN (
        'MXN', 'KWD', 'MMK', 'BDT', 'CZK', 'KHR', 'KES', 'LAK', 'RUB',
        'EGP', 'PLN', 'LKR', 'IQD', 'JOD', 'QAR', 'MVR', 'NPR', 'ILS',
        'HUF', 'PKR', 'BTN', 'MNT'
    )
),

-- 4. รวมข้อมูลทั้ง 2 กลุ่มเข้าด้วยกัน
combined AS (
    SELECT BankDate, currency, timestamp_bank, updated_date, avg_buy, avg_sell
    FROM thai_agg
    UNION ALL
    SELECT BankDate, currency, timestamp_bank, updated_date, avg_buy, avg_sell
    FROM bot_shifted
)

-- 5. ผลลัพธ์สุดท้าย พร้อมเชื่อม currency_master เรียงลำดับ currency_order (1-49)
SELECT
    c.BankDate,
    c.currency,
    c.timestamp_bank,
    c.updated_date,
    c.avg_buy   AS [BUY_Average],
    c.avg_sell  AS [SELL_Average],
    b.currency_order,
    b.currency_id,
    b.currency_type,
    b.is_avg,
    b.is_bot
FROM combined c
INNER JOIN dbo.currency_master b ON c.currency = b.currency_name
WHERE b.is_avg = 'Y' AND b.active = 'Y';
`;
  await exec(sqlAlterViewAvg, 'Step 3: Alter View dbo.vw_FxRate_AVG');

  // Step 4: Verification
  console.log('\n🔍 --- Verifying Results ---');
  
  // 4.1 Count distinct currencies in vw_FxRate_AVG for 2026-09-11
  const rowsAvg = await query(`
    SELECT COUNT(*) AS total_currencies, MIN(currency_order) as min_order, MAX(currency_order) as max_order
    FROM dbo.vw_FxRate_AVG
    WHERE BankDate = '2026-09-11';
  `);
  console.log('📊 vw_FxRate_AVG on 2026-09-11:', rowsAvg[0]);

  // 4.2 Check KHR and LAK rates in vw_FxRate_AVG
  const rowsKhrLak = await query(`
    SELECT currency, BankDate, BUY_Average, SELL_Average, currency_order, currency_type
    FROM dbo.vw_FxRate_AVG
    WHERE BankDate = '2026-09-11' AND currency IN ('KHR', 'LAK', 'USD', 'BTN');
  `);
  console.log('\n📊 Sample rates in vw_FxRate_AVG (2026-09-11):');
  console.table(rowsKhrLak);

  // 4.3 Verify vw_FxRate_BOT still works
  const rowsBot = await query(`
    SELECT TOP 3 BankDate, currency, BUY_Average, SELL_Average, currency_type
    FROM dbo.vw_FxRate_BOT
    ORDER BY BankDate DESC, currency_order;
  `);
  console.log('\n📊 Sample rates in vw_FxRate_BOT (Intact):');
  console.table(rowsBot);

  console.log('\n🎉 ALL UPDATES APPLIED AND VERIFIED SUCCESSFULLY!');
  conn.close();
}

conn.on('connect', (err) => {
  if (err) {
    console.error('❌ Connection failed:', err.message);
    process.exit(1);
  }
  main().catch((err) => {
    console.error('❌ Execution error:', err);
    conn.close();
  });
});

conn.connect();
