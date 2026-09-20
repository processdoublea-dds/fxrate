import { NextRequest, NextResponse } from 'next/server';
import { Connection, Request, TYPES } from 'tedious';

export const maxDuration = 120; // 2 mins max duration for reconciliation

interface NetSuiteRecord {
  currency_name?: string;
  currency_id?: string;
  symbol?: string;
  effective_date?: string;
  posting_date?: string;
  bot_effectivedate?: string;
  buying_rate?: string;
  selling_rate?: string;
  buyingtransfer?: string;
  sellingrate?: string;
  midrate?: string;
}

function getDbConfig() {
  const host = process.env.DB_HOST || process.env.ADDRESS_MYGREEN || '203.150.86.17';
  const dbUser = process.env.DB_USER || 'chatchawan';
  const dbPass = process.env.DB_PASS || 'Mango@doublea!';
  const dbName = process.env.DB_NAME || 'process_team';

  return {
    server: host.replace(/["']/g, '').trim(),
    authentication: {
      type: 'default' as const,
      options: {
        userName: dbUser.replace(/["']/g, '').trim(),
        password: dbPass.replace(/["']/g, '').trim()
      }
    },
    options: {
      encrypt: false,
      database: dbName.replace(/["']/g, '').trim(),
      rowCollectionOnRequestCompletion: true,
      trustServerCertificate: true,
      requestTimeout: 30000
    }
  };
}

function queryDb(sql: string, params: Array<{ name: string; type: any; value: any }> = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const conn = new Connection(getDbConfig());
    conn.on('connect', (err) => {
      if (err) return reject(err);
      const req = new Request(sql, (err2, count, rows) => {
        conn.close();
        if (err2) return reject(err2);
        resolve(rows || []);
      });
      params.forEach((p) => req.addParameter(p.name, p.type, p.value));
      conn.execSql(req);
    });
    conn.connect();
  });
}

async function getNetSuiteToken(): Promise<string> {
  const email = process.env.NETSUITE_PASSPORT_EMAIL || 'sutti_m@mibholding.com';
  const password = process.env.NETSUITE_PASSPORT_PASSWORD || 'g832Qi16';

  const res = await fetch('https://api-passport.advanceagro.net/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  if (!res.ok) {
    throw new Error(`Passport login failed HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const token = data?.data?.token_netsuite;
  if (!token) throw new Error('NetSuite token missing in Passport response');
  return token;
}

async function fetchNetSuiteRecords(scriptName: string, token: string): Promise<NetSuiteRecord[]> {
  const url = `https://8158655.restlets.api.netsuite.com/app/site/hosting/restlet.nl?script=${scriptName}&deploy=1`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  });

  if (!res.ok) {
    throw new Error(`NetSuite ${scriptName} HTTP ${res.status}: ${await res.text()}`);
  }

  const raw = await res.json();
  return Array.isArray(raw) ? raw : (raw?.data || []);
}

export async function GET(request: NextRequest) {
  // Authorization check (Bearer token or secret query param)
  const authHeader = request.headers.get('authorization');
  const querySecret = request.nextUrl.searchParams.get('secret');
  const expectedSecret = process.env.CRON_SECRET || '099268a839ddd7964d97c87057b29226d1582a2ac41dbcceb0706f4230559278';

  const isAuthorized =
    authHeader === `Bearer ${expectedSecret}` ||
    querySecret === expectedSecret;

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // 1. Resolve Target Date (Bangkok timezone default)
    const bangkokNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    const yyyy = bangkokNow.getFullYear();
    const mm = String(bangkokNow.getMonth() + 1).padStart(2, '0');
    const dd = String(bangkokNow.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    const paramDate = request.nextUrl.searchParams.get('date');
    const targetDate = paramDate && /^\d{4}-\d{2}-\d{2}$/.test(paramDate.trim()) ? paramDate.trim() : todayStr;
    const [tYear, tMonth, tDay] = targetDate.split('-');
    const dateFmt = `${tDay}/${tMonth}/${tYear}`; // e.g. 20/09/2026

    // 2. Acquire NetSuite Bearer Token
    const token = await getNetSuiteToken();

    // ----------------------------------------------------
    // 3. RECONCILE AVG 3 THAI BANKS (50 Currencies)
    // ----------------------------------------------------
    const sqlAvg = `
      declare @targetDate varchar(20) = @dateParam;
      select currency, currency_id, currency_order,
             format([date], 'dd/MM/yyyy') as [date],
             format(effective_date, 'dd/MM/yyyy') as effective_date,
             BUY_Average as buying_rate,
             SELL_Average as selling_rate
      from vw_FxRate_AVG
      where effective_date = (
          select max(effective_date) from vw_FxRate_AVG where effective_date <= cast(@targetDate as date)
      )
      order by currency_order;
    `;
    const avgRows = await queryDb(sqlAvg, [{ name: 'dateParam', type: TYPES.VarChar, value: targetDate }]);
    const mangoAvg = avgRows.map(r => ({
      currency: r[0].value,
      currency_id: r[1].value,
      currency_order: r[2].value,
      date: r[3].value,
      effective_date: r[4].value,
      buying_rate: parseFloat(r[5].value),
      selling_rate: parseFloat(r[6].value)
    }));

    const nsAvgList = await fetchNetSuiteRecords('customscript_avg_exchange_rate', token);
    const nsAvgToday = nsAvgList.filter(x => x.effective_date === dateFmt || x.posting_date === dateFmt);
    const nsAvgMap = new Map<string, NetSuiteRecord>();
    nsAvgToday.forEach(x => {
      if (x.currency_name) nsAvgMap.set(x.currency_name, x);
    });

    let avgMatch = 0, avgMismatch = 0, avgMissing = 0;
    const avgDiffList = [];

    for (const m of mangoAvg) {
      const ns = nsAvgMap.get(m.currency);
      if (!ns) {
        avgMissing++;
        avgDiffList.push({
          currency: m.currency,
          currency_id: m.currency_id,
          date: m.date,
          effective_date: m.effective_date,
          ns_effective_date: '-',
          mango_buying: m.buying_rate,
          ns_buying: null,
          mango_selling: m.selling_rate,
          ns_selling: null,
          status: 'MISSING_IN_NS'
        });
        continue;
      }

      const nsBuy = parseFloat(ns.buying_rate || '0');
      const nsSell = parseFloat(ns.selling_rate || '0');
      const deltaBuy = Math.abs(m.buying_rate - nsBuy);
      const deltaSell = Math.abs(m.selling_rate - nsSell);
      const isMatch = deltaBuy < 0.000001 && deltaSell < 0.000001;

      if (isMatch) avgMatch++;
      else avgMismatch++;

      avgDiffList.push({
        currency: m.currency,
        currency_id: m.currency_id,
        date: m.date,
        effective_date: m.effective_date,
        ns_effective_date: ns.effective_date || ns.posting_date,
        mango_buying: m.buying_rate,
        ns_buying: nsBuy,
        mango_selling: m.selling_rate,
        ns_selling: nsSell,
        delta_buy: deltaBuy,
        delta_sell: deltaSell,
        status: isMatch ? 'MATCH' : 'MISMATCH'
      });
    }

    const avgStatus = (avgMatch === mangoAvg.length && mangoAvg.length > 0) ? '100% MATCH' : avgMissing > 0 ? 'MISSING_DATA' : 'MISMATCH';
    const avgPayload = {
      verified_at: new Date().toISOString(),
      target_date: targetDate,
      module: 'AVG',
      source_count: mangoAvg.length,
      target_count: nsAvgToday.length,
      match_count: avgMatch,
      mismatch_count: avgMismatch,
      missing_count: avgMissing,
      status: avgStatus,
      records: avgDiffList
    };

    // Save AVG to dbo.log_reconciliation
    const sqlSaveAvg = `
      DELETE FROM dbo.log_reconciliation WHERE recon_date = @rDate AND module = 'AVG';
      INSERT INTO dbo.log_reconciliation (recon_date, module, source_count, target_count, match_count, mismatch_count, missing_count, status, detail_json, created_at)
      VALUES (@rDate, 'AVG', @sCount, @tCount, @mCount, @misCount, @missCount, @status, @detailJson, GETDATE());
    `;
    await queryDb(sqlSaveAvg, [
      { name: 'rDate', type: TYPES.Date, value: new Date(targetDate) },
      { name: 'sCount', type: TYPES.Int, value: mangoAvg.length },
      { name: 'tCount', type: TYPES.Int, value: nsAvgToday.length },
      { name: 'mCount', type: TYPES.Int, value: avgMatch },
      { name: 'misCount', type: TYPES.Int, value: avgMismatch },
      { name: 'missCount', type: TYPES.Int, value: avgMissing },
      { name: 'status', type: TYPES.VarChar, value: avgStatus },
      { name: 'detailJson', type: TYPES.NVarChar, value: JSON.stringify(avgPayload) }
    ]);

    // ----------------------------------------------------
    // 4. RECONCILE BOT (29 Currencies)
    // ----------------------------------------------------
    const sqlBot = `
      declare @targetDate varchar(20) = @dateParam;
      select currency, currency_id, currency_order,
             format([date], 'dd/MM/yyyy') as [date],
             format(effective_date, 'dd/MM/yyyy') as effective_date,
             BUY_Average as buyingtransfer,
             SELL_Average as sellingrate,
             (BUY_Average + SELL_Average)/2 as midrate
      from vw_FxRate_BOT
      where effective_date = (
          select max(effective_date) from vw_FxRate_BOT where effective_date <= cast(@targetDate as date)
      )
      order by currency_order;
    `;
    const botRows = await queryDb(sqlBot, [{ name: 'dateParam', type: TYPES.VarChar, value: targetDate }]);
    const mangoBot = botRows.map(r => ({
      currency: r[0].value,
      currency_id: r[1].value,
      currency_order: r[2].value,
      date: r[3].value,
      effective_date: r[4].value,
      buyingtransfer: parseFloat(r[5].value),
      sellingrate: parseFloat(r[6].value),
      midrate: parseFloat(r[7].value)
    }));

    const nsBotList = await fetchNetSuiteRecords('customscript_bot_exchange_rate', token);
    const nsBotToday = nsBotList.filter(x => x.bot_effectivedate === dateFmt || x.effective_date === dateFmt);
    const nsBotMap = new Map<string, NetSuiteRecord>();
    nsBotToday.forEach(x => {
      if (x.symbol) nsBotMap.set(x.symbol, x);
    });

    let botMatch = 0, botMismatch = 0, botMissing = 0;
    const botDiffList = [];

    for (const m of mangoBot) {
      const ns = nsBotMap.get(m.currency);
      if (!ns) {
        botMissing++;
        botDiffList.push({
          currency: m.currency,
          currency_id: m.currency_id,
          date: m.date,
          effective_date: m.effective_date,
          ns_effective_date: '-',
          mango_transfer: m.buyingtransfer,
          ns_transfer: null,
          mango_sell: m.sellingrate,
          ns_sell: null,
          status: 'MISSING_IN_NS'
        });
        continue;
      }

      const nsTransfer = parseFloat(ns.buyingtransfer || '0');
      const nsSell = parseFloat(ns.sellingrate || '0');
      const nsMid = parseFloat(ns.midrate || '0');

      const deltaTransfer = Math.abs(m.buyingtransfer - nsTransfer);
      const deltaSell = Math.abs(m.sellingrate - nsSell);
      const deltaMid = Math.abs(m.midrate - nsMid);
      const isMatch = deltaTransfer < 0.000001 && deltaSell < 0.000001 && deltaMid < 0.000001;

      if (isMatch) botMatch++;
      else botMismatch++;

      botDiffList.push({
        currency: m.currency,
        currency_id: m.currency_id,
        date: m.date,
        effective_date: m.effective_date,
        ns_effective_date: ns.bot_effectivedate || ns.effective_date,
        mango_transfer: m.buyingtransfer,
        ns_transfer: nsTransfer,
        mango_selling: m.sellingrate,
        ns_selling: nsSell,
        mango_mid: m.midrate,
        ns_mid: nsMid,
        delta_transfer: deltaTransfer,
        delta_sell: deltaSell,
        delta_mid: deltaMid,
        status: isMatch ? 'MATCH' : 'MISMATCH'
      });
    }

    const botStatus = (botMatch === mangoBot.length && mangoBot.length > 0) ? '100% MATCH' : botMissing > 0 ? 'MISSING_DATA' : 'MISMATCH';
    const botPayload = {
      verified_at: new Date().toISOString(),
      target_date: targetDate,
      module: 'BOT',
      source_count: mangoBot.length,
      target_count: nsBotToday.length,
      match_count: botMatch,
      mismatch_count: botMismatch,
      missing_count: botMissing,
      status: botStatus,
      records: botDiffList
    };

    // Save BOT to dbo.log_reconciliation
    const sqlSaveBot = `
      DELETE FROM dbo.log_reconciliation WHERE recon_date = @rDate AND module = 'BOT';
      INSERT INTO dbo.log_reconciliation (recon_date, module, source_count, target_count, match_count, mismatch_count, missing_count, status, detail_json, created_at)
      VALUES (@rDate, 'BOT', @sCount, @tCount, @mCount, @misCount, @missCount, @status, @detailJson, GETDATE());
    `;
    await queryDb(sqlSaveBot, [
      { name: 'rDate', type: TYPES.Date, value: new Date(targetDate) },
      { name: 'sCount', type: TYPES.Int, value: mangoBot.length },
      { name: 'tCount', type: TYPES.Int, value: nsBotToday.length },
      { name: 'mCount', type: TYPES.Int, value: botMatch },
      { name: 'misCount', type: TYPES.Int, value: botMismatch },
      { name: 'missCount', type: TYPES.Int, value: botMissing },
      { name: 'status', type: TYPES.VarChar, value: botStatus },
      { name: 'detailJson', type: TYPES.NVarChar, value: JSON.stringify(botPayload) }
    ]);

    const isAllMatch = avgStatus === '100% MATCH' && botStatus === '100% MATCH';

    return NextResponse.json({
      success: true,
      date: targetDate,
      date_formatted: dateFmt,
      overall_status: isAllMatch ? '100% MATCH' : 'MISMATCH',
      avg: {
        source_count: mangoAvg.length,
        target_count: nsAvgToday.length,
        match_count: avgMatch,
        mismatch_count: avgMismatch,
        missing_count: avgMissing,
        status: avgStatus
      },
      bot: {
        source_count: mangoBot.length,
        target_count: nsBotToday.length,
        match_count: botMatch,
        mismatch_count: botMismatch,
        missing_count: botMissing,
        status: botStatus
      }
    });

  } catch (err: any) {
    console.error('Reconciliation error:', err);
    return NextResponse.json({
      success: false,
      error: err.message || String(err)
    }, { status: 500 });
  }
}
