/**
 * Apply Accounting Feedback SQL Changes:
 * 1. Update dbo.currency_master: is_bot = 'N' for BTN and MNT
 * 2. Alter dbo.vw_FxRate_AVG:
 *    - bot_shifted BankDate set to CAST(b.timestamp_bank AS date) to match timestamp_bank
 * 3. Alter dbo.vw_FxRate_BOT:
 *    - Exclude BTN and MNT (filter by is_bot = 'Y' and NOT IN ('BTN', 'MNT'))
 * 4. Patch dbo.exrate for BOT VND (divide by 100 from 2026-07-01 to present)
 * 5. Verify results
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
  if (t.startsWith('ADDRESS_MYGREEN')) host = t.split('=')[1].replace(/["']/g, '').trim();
  if (t.includes('Database raw price')) { isDb = true; continue; }
  if (isDb && t && !t.startsWith('#')) {
    const parts = t.split('=');
    const k = parts[0].trim();
    const v = parts.slice(1).join('=').replace(/["']/g, '').trim();
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
    rowCollectionOnRequestCompletion: true,
    trustServerCertificate: true,
    requestTimeout: 60000
  }
};

const conn = new Connection(config);

function exec(sql, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n⏳ Executing: ${label}...`);
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
    const req = new Request(sql, (err, rowCount, rows) => {
      if (err) return reject(err);
      const res = (rows || []).map(r => {
        const obj = {};
        r.forEach(c => obj[c.metadata.colName] = c.value);
        return obj;
      });
      resolve(res);
    });
    conn.execSql(req);
  });
}

conn.on('connect', async (err) => {
  if (err) {
    console.error('❌ Connection failed:', err);
    process.exit(1);
  }
  console.log('✅ Connected to SQL Server:', host, 'DB:', db);

  try {
    // Step 1: Update currency_master (is_bot = 'N' for BTN and MNT)
    const sqlMaster = `
UPDATE dbo.currency_master
SET is_bot = 'N'
WHERE currency_name IN ('BTN', 'MNT');
`;
    await exec(sqlMaster, 'Step 1: Update currency_master (is_bot = N for BTN, MNT)');

    // Step 2: Alter dbo.vw_FxRate_AVG
    // bot_shifted uses CAST(b.timestamp_bank AS date) AS BankDate
    const sqlAlterAvg = `
ALTER VIEW [dbo].[vw_FxRate_AVG]
AS
-- 1. ชุดวันที่ทั้งหมดที่มีเรทของ 3 ธนาคารไทย (BankDate = วันที่ T) พร้อม updated_date และ timestamp_bank ประจำรอบ
WITH thai_dates AS (
    SELECT
        CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.timestamp_bank)),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, rf.updated_date))
            ) AS date
        ) AS BankDate,
        MAX(rf.timestamp_bank) AS timestamp_bank,
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

        -- BUY Average rules
        CASE
            WHEN currency IN (
                'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
                'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
            )
            THEN AVG(buy_tt)
            ELSE AVG(buy_notes)
        END AS avg_buy,

        -- SELL Average rules
        CASE
            WHEN currency IN (
                'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
                'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
            )
            THEN AVG(sell_tt)
            ELSE AVG(sell_notes)
        END AS avg_sell

    FROM thai_base
    GROUP BY currency, BankDate
),

-- 3. ข้อมูลกลุ่มที่ 2: 23 สกุลเงิน BOT/Bloomberg
--    กำหนด BankDate ให้ตรงกับ timestamp_bank (วันที่เรทจริงจาก BOT) ตาม Feedback บัญชี
bot_shifted AS (
    SELECT
        CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, b.timestamp_bank)),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, b.updated_date))
            ) AS date
        ) AS BankDate,       -- 👈 Bank DATE ตรงกับ TimeStamp Bank ตามความต้องการฝ่ายบัญชี
        cm.currency_name AS currency,
        b.timestamp_bank,    -- วันที่เรทจริงจาก BOT (entry_date)
        td.updated_date,     -- updated_date ประจำรอบดึงข้อมูลของ Thai Banks (ใช้เป็นรอบประจำวัน)
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
        'HUF', 'PKR', 'BTN', 'MNT', 'PGK'
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

-- 5. ผลลัพธ์สุดท้าย พร้อมเชื่อม currency_master เรียงลำดับ currency_order (1-50)
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
    await exec(sqlAlterAvg, 'Step 2: Alter View dbo.vw_FxRate_AVG (BankDate = timestamp_bank for BOT)');

    // Step 3: Alter dbo.vw_FxRate_BOT
    // Filter out BTN and MNT
    const sqlAlterBot = `
ALTER VIEW [dbo].[vw_FxRate_BOT]
AS
WITH base AS (
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
    WHERE rf.bank_name IN ('BOT', 'BLOOMBERG')
),
agg AS (
    SELECT
        currency,
        MAX(timestamp_bank) AS timestamp_bank,
        MAX(updated_date)   AS updated_date,
        CAST(
            COALESCE(
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, MAX(timestamp_bank))),
                DATEADD(YEAR, 0, TRY_CONVERT(datetime2, MAX(updated_date)))
            ) AS date
        ) AS BankDate,
        AVG(buy_notes)    AS avg_buy_notes,
        AVG(buy_transfer) AS avg_buy_transfer,
        AVG(buy_tt)       AS avg_buy_tt,
        AVG(sell_tt)      AS avg_sell_tt,
        AVG(sell_notes)   AS avg_sell_notes
    FROM base
    GROUP BY currency, BankDate
)
SELECT
    a.BankDate,
    a.currency,
    a.timestamp_bank,
    a.updated_date,

    -- BUY Average rules
    CASE
        WHEN a.currency IN (
            'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
            'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
        )
        THEN a.avg_buy_transfer
        ELSE a.avg_buy_transfer
    END AS [BUY_Average],

    -- SELL Average rules
    CASE
        WHEN a.currency IN (
            'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
            'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
        )
        THEN a.avg_sell_tt
        ELSE a.avg_sell_notes
    END AS [SELL_Average],

    b.currency_order,
    b.currency_id,
    b.currency_type,
    b.is_avg,
    b.is_bot
    
FROM agg AS a
INNER JOIN dbo.currency_master b ON a.currency = b.currency_name
-- ✅ กรอง is_bot = 'Y', active = 'Y' และไม่เอา BTN, MNT (ส่งไป View AVG แทนแล้ว)
WHERE b.is_bot = 'Y' 
  AND b.active = 'Y'
  AND b.currency_name NOT IN ('BTN', 'MNT');
`;
    await exec(sqlAlterBot, 'Step 3: Alter View dbo.vw_FxRate_BOT (Exclude BTN, MNT)');

    // Step 4: Patch dbo.exrate for BOT VND (divide by 100)
    const sqlPatchVnd = `
UPDATE dbo.exrate
SET 
    sell_tt = ROUND(sell_tt / 100.0, 5),
    sell_notes = ROUND(sell_notes / 100.0, 5),
    buy_tt = ROUND(buy_tt / 100.0, 5),
    buy_sight = ROUND(buy_sight / 100.0, 5),
    buy_transfer = ROUND(buy_transfer / 100.0, 5),
    buy_notes = ROUND(buy_notes / 100.0, 5)
WHERE bank_name = 'BOT'
  AND currency = 'VND'
  AND (timestamp_bank >= '2026-07-01' OR updated_date >= '2026-07-01')
  AND (sell_tt > 0.05 OR buy_transfer > 0.05 OR sell_notes > 0.05);
`;
    await exec(sqlPatchVnd, 'Step 4: Patch BOT VND in dbo.exrate (/100 from 2026-07-01)');

    // Step 5: Verification Queries
    console.log('\n📊 --- VERIFICATION ---');

    // 5.1 Check BTN and MNT in currency_master
    const checkMaster = await query(`
SELECT currency_name, is_avg, is_bot, currency_order 
FROM dbo.currency_master 
WHERE currency_name IN ('BTN', 'MNT')
`);
    console.log('\n1. Currency Master for BTN & MNT:');
    console.table(checkMaster);

    // 5.2 Check vw_FxRate_AVG sample for 2026-09-15
    const checkAvg = await query(`
SELECT BankDate, currency, timestamp_bank, updated_date, BUY_Average, SELL_Average, currency_type
FROM dbo.vw_FxRate_AVG
WHERE CAST(updated_date AS date) = '2026-09-15'
  AND currency IN ('USD', 'LKR', 'KHR', 'LAK', 'BTN', 'MNT', 'PGK', 'VND')
ORDER BY currency_order;
`);
    console.log('\n2. vw_FxRate_AVG sample (updated on 2026-09-15):');
    console.table(checkAvg);

    // 5.3 Count rows in vw_FxRate_AVG for updated_date = 2026-09-15
    const countAvg = await query(`
SELECT COUNT(*) AS total_avg_currencies
FROM dbo.vw_FxRate_AVG
WHERE CAST(updated_date AS date) = '2026-09-15';
`);
    console.log(`\nTotal currencies in vw_FxRate_AVG for today cycle: ${countAvg[0].total_avg_currencies}`);

    // 5.4 Check vw_FxRate_BOT for BTN, MNT, and VND
    const checkBot = await query(`
SELECT BankDate, currency, timestamp_bank, BUY_Average, SELL_Average
FROM dbo.vw_FxRate_BOT
WHERE BankDate >= '2026-09-11'
  AND currency IN ('BTN', 'MNT', 'VND', 'KHR', 'LAK')
ORDER BY BankDate DESC, currency;
`);
    console.log('\n3. vw_FxRate_BOT recent records (should NOT have BTN/MNT, VND should be ~0.00127):');
    console.table(checkBot);

    // 5.5 Count in vw_FxRate_BOT for latest BankDate
    const countBot = await query(`
SELECT BankDate, COUNT(*) AS bot_currency_count
FROM dbo.vw_FxRate_BOT
GROUP BY BankDate
ORDER BY BankDate DESC;
`);
    console.log('\n4. Currency count in vw_FxRate_BOT by BankDate:');
    console.table(countBot.slice(0, 5));

    conn.close();
    console.log('\n🎉 Phase 1 Database changes completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    conn.close();
    process.exit(1);
  }
});

conn.connect();
