/**
 * Patch PGK and separate entry_date (timestamp_bank) vs posting_date (BankDate) in vw_FxRate_AVG
 * 1. Update dbo.currency_master: is_avg = 'Y', currency_type = 'BOT', currency_order = 50 for PGK
 * 2. Alter dbo.vw_FxRate_AVG:
 *    - Add PGK to bot_shifted (total 23 BOT currencies)
 *    - Keep b.timestamp_bank as timestamp_bank (rate date)
 *    - Keep td.BankDate as BankDate (posting date)
 * 3. Verify on 2026-09-14
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
      const res = rows.map(r => {
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
    // Step 1: Update currency_master for PGK
    const sqlMaster = `
UPDATE dbo.currency_master
SET is_avg = 'Y', currency_type = 'BOT', currency_order = 50
WHERE currency_name = 'PGK';
`;
    await exec(sqlMaster, 'Step 1: Update dbo.currency_master for PGK');

    // Step 2: Alter View dbo.vw_FxRate_AVG
    const sqlAlterView = `
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

        -- BUY Average rules (สูตรดั้งเดิมแท้ๆ 100% ห้ามเปลี่ยน)
        CASE
            WHEN currency IN (
                'USD','HKD','CNY','EUR','AUD','SGD','NZD','GBP','JPY','CHF',
                'SEK','CAD','DKK','NOK','AED','INR','MYR','IDR'
            )
            THEN AVG(buy_tt)
            ELSE AVG(buy_notes)
        END AS avg_buy,

        -- SELL Average rules (สูตรดั้งเดิมแท้ๆ 100% ห้ามเปลี่ยน)
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

-- 3. ข้อมูลกลุ่มที่ 2: 23 สกุลเงิน BOT/Bloomberg โดย Shift วันที่ให้ตรงกับ BankDate ของ Thai Banks
--    และใช้ b.timestamp_bank วันที่ของเรทจริงจาก BOT (สำหรับ entry_date)
bot_shifted AS (
    SELECT
        td.BankDate,
        cm.currency_name AS currency,
        b.timestamp_bank,    -- 👈 วันที่เรทจริงจาก BOT
        td.updated_date,     -- 👈 updated_date รอบของ Thai Banks
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
    await exec(sqlAlterView, 'Step 2: Alter View dbo.vw_FxRate_AVG');

    // Step 3: Verification
    console.log('\n📊 Verifying results for 2026-09-14...');
    const rows = await query(`
SELECT 
    BankDate,
    currency,
    FORMAT(timestamp_bank, 'dd/MM/yyyy') AS entry_date,
    FORMAT(BankDate, 'dd/MM/yyyy') AS posting_date,
    BUY_Average,
    SELL_Average,
    currency_order,
    currency_id,
    currency_type
FROM dbo.vw_FxRate_AVG
WHERE BankDate = '2026-09-14'
ORDER BY currency_order;
`);

    console.log(`✅ Total rows in vw_FxRate_AVG for 2026-09-14: ${rows.length}`);
    const pgk = rows.find(r => r.currency === 'PGK');
    console.log('\n🇵🇬 PGK row:', pgk);
    const mmk = rows.find(r => r.currency === 'MMK');
    console.log('🇲🇲 MMK row:', mmk);
    const usd = rows.find(r => r.currency === 'USD');
    console.log('🇺🇸 USD row:', usd);

    conn.close();
  } catch (e) {
    console.error('❌ Script failed:', e);
    conn.close();
    process.exit(1);
  }
});

conn.connect();
