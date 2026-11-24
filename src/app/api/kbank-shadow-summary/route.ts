import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const isZeroOrEmpty = (val: any) => val === null || val === undefined || val === 0 || val === '0' || val === '';

export async function GET(request: Request) {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '30', 10);
    const format = url.searchParams.get('format');
    const accept = request.headers.get('accept') || '';
    const wantsHtml = format === 'html' || (!format && accept.includes('text/html'));

    try {
        // Query recent KBANK_SHADOW runs from scrape_logs
        const { data: logs, error } = await supabaseAdmin
            .from('scrape_logs')
            .select('id, started_at, completed_at, status, records_count, duration_ms, error_message, raw_response')
            .eq('source', 'KBANK_SHADOW')
            .order('id', { ascending: false })
            .limit(limit);

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        const totalRuns = logs ? logs.length : 0;
        let passCount = 0;
        let crossRoundCount = 0;
        let failCount = 0;
        let staleRetryCount = 0;
        let waitingCount = 0;
        let retroMatchedCount = 0;
        let browserlessFirstCount = 0;
        let totalDurationMs = 0;
        let durationRunCount = 0;

        const parsedLogs = (logs || []).map(l => {
            let details: any = null;
            try {
                details = l.raw_response ? JSON.parse(l.raw_response) : null;
            } catch (_) {}
            return { log: l, details };
        });

        // Batch-fetch BrowserAct exchange_rates for retroactive comparison
        const pendingDates = Array.from(
            new Set(
                parsedLogs
                    .filter(({ details }) =>
                        details?.match_status === 'BROWSERLESS_OK_NO_BROWSERACT_DATA_YET' &&
                        details?.browserless_rates &&
                        details?.rate_date
                    )
                    .map(({ details }) => String(details.rate_date))
            )
        );

        const prodByDate = new Map<string, {
            byCurrency: Map<string, any>;
            bank_timestamp: string | null;
            fetched_at: string | null;
        }>();

        if (pendingDates.length > 0) {
            const { data: prodRows } = await supabaseAdmin
                .from('exchange_rates')
                .select('rate_date, currency, buy_sight, buy_tt, sell_tt, buy_notes, sell_notes, bank_timestamp, fetched_at')
                .eq('source', 'KBANK')
                .in('rate_date', pendingDates);

            for (const row of prodRows || []) {
                const dateKey = String(row.rate_date);
                let entry = prodByDate.get(dateKey);
                if (!entry) {
                    entry = {
                        byCurrency: new Map<string, any>(),
                        bank_timestamp: row.bank_timestamp || null,
                        fetched_at: row.fetched_at || null,
                    };
                    prodByDate.set(dateKey, entry);
                }
                entry.byCurrency.set(row.currency, row);
                if (!entry.bank_timestamp && row.bank_timestamp) {
                    entry.bank_timestamp = row.bank_timestamp;
                }
                if (!entry.fetched_at && row.fetched_at) {
                    entry.fetched_at = row.fetched_at;
                }
            }
        }

        const compareFields = ['buy_sight', 'buy_tt', 'sell_tt', 'buy_notes', 'sell_notes'] as const;

        const history = parsedLogs.map(({ log: l, details }) => {
            const rawVariances = details?.comparison?.variances || [];

            // Clean variances by filtering out null vs 0 equivalencies
            let cleanVariances = rawVariances.map((v: any) => {
                if (!v.diffs) return v;
                const cleanDiffs: Record<string, any> = {};
                for (const [f, d] of Object.entries(v.diffs) as [string, any][]) {
                    if (!isZeroOrEmpty(d.browserless) || !isZeroOrEmpty(d.browseract)) {
                        cleanDiffs[f] = d;
                    }
                }
                if (Object.keys(cleanDiffs).length > 0) {
                    return { currency: v.currency, diffs: cleanDiffs };
                }
                return null;
            }).filter(Boolean);

            const blRound = details?.browserless?.round != null ? String(details.browserless.round) : null;
            const blTs = details?.browserless?.bank_timestamp || null;
            let baTs = details?.browseract?.bank_timestamp || null;
            let baFetchedAt: string | null = details?.browseract?.fetched_at || null;

            const isSkipped = l.status === 'skipped' || details?.match_status === 'STALE_DATE_SKIPPED';
            const isPendingBrowserAct = details?.match_status === 'BROWSERLESS_OK_NO_BROWSERACT_DATA_YET';
            const prodData = isPendingBrowserAct && details?.rate_date
                ? prodByDate.get(String(details.rate_date))
                : undefined;

            let isRetroCompared = false;
            let isWaitingBrowserAct = false;

            if (isPendingBrowserAct && !isSkipped) {
                if (details?.browserless_rates && prodData && prodData.byCurrency.size > 0) {
                    const blRates: any[] = Array.isArray(details.browserless_rates)
                        ? details.browserless_rates
                        : Object.values(details.browserless_rates);

                    const retroVariances: any[] = [];
                    for (const bl of blRates) {
                        const prod = prodData.byCurrency.get(bl.currency);
                        if (!prod) {
                            retroVariances.push({
                                currency: bl.currency,
                                reason: 'MISSING_IN_BROWSERACT_PROD',
                            });
                            continue;
                        }

                        const diffs: Record<string, { browserless: any; browseract: any }> = {};
                        for (const f of compareFields) {
                            if (isZeroOrEmpty(bl[f]) && isZeroOrEmpty(prod[f])) continue;
                            const v1 = Number(bl[f] ?? 0);
                            const v2 = Number(prod[f] ?? 0);
                            if (Math.abs(v1 - v2) > 0.0001) {
                                diffs[f] = { browserless: v1, browseract: v2 };
                            }
                        }
                        if (Object.keys(diffs).length > 0) {
                            retroVariances.push({ currency: bl.currency, diffs });
                        }
                    }

                    cleanVariances = retroVariances;
                    baTs = prodData.bank_timestamp || baTs;
                    baFetchedAt = prodData.fetched_at || baFetchedAt;
                    isRetroCompared = true;
                    retroMatchedCount++;
                } else {
                    isWaitingBrowserAct = true;
                }
            }

            // Morning rounds only: Round 1 (Primary) or Round 2
            const isMorningRound = blRound === '1' || blRound === '2';
            const isAfternoonRound = Boolean(blRound && !isMorningRound);

            let normalizedStatus = 'PASS_ROUND_1_MATCH';
            if (isSkipped) {
                normalizedStatus = 'STALE_DATE_SKIPPED';
                staleRetryCount++;
            } else if (l.status === 'failed') {
                normalizedStatus = 'FAILED';
                failCount++;
            } else if (isAfternoonRound) {
                normalizedStatus = 'AFTERNOON_ROUND_SKIPPED';
                crossRoundCount++;
            } else if (isWaitingBrowserAct) {
                normalizedStatus = 'WAITING_BROWSERACT';
                waitingCount++;
            } else if (cleanVariances.length === 0) {
                normalizedStatus = blRound === '1' ? 'PASS_ROUND_1_MATCH' : 'PASS_ROUND_2_MATCH';
                passCount++;
            } else if (cleanVariances.length <= 1 && cleanVariances[0]?.currency === 'USD') {
                normalizedStatus = 'PASS_USD_TIER_DIFF';
                passCount++;
            } else {
                normalizedStatus = 'VARIANCE_DETECTED';
            }

            if (!isSkipped && l.duration_ms && l.duration_ms > 0) {
                totalDurationMs += l.duration_ms;
                durationRunCount++;
            }

            let headToHeadDeltaSeconds: number | null = null;
            const blFinishedAt = l.completed_at || details?.tested_at || l.started_at;
            if (!isSkipped && blFinishedAt && baFetchedAt) {
                const blTime = new Date(blFinishedAt).getTime();
                const baTime = new Date(baFetchedAt).getTime();
                if (!Number.isNaN(blTime) && !Number.isNaN(baTime)) {
                    headToHeadDeltaSeconds = Math.round((baTime - blTime) / 1000);
                    if (headToHeadDeltaSeconds > 0) {
                        browserlessFirstCount++;
                    }
                }
            }

            return {
                id: l.id,
                tested_at: l.started_at,
                completed_at: l.completed_at || null,
                status: l.status,
                raw_match_status: details?.match_status || l.status,
                normalized_status: normalizedStatus,
                retroactively_compared: isRetroCompared,
                duration_seconds: l.duration_ms ? (l.duration_ms / 1000).toFixed(1) : '0',
                currencies_checked: l.records_count,
                round: blRound || 'N/A',
                browserless_timestamp: blTs || 'N/A',
                browseract_timestamp: baTs || 'N/A',
                browseract_fetched_at: baFetchedAt,
                head_to_head_lead_seconds: headToHeadDeltaSeconds,
                effective_diff_count: isWaitingBrowserAct || isSkipped ? 0 : cleanVariances.length,
                raw_diff_count: isRetroCompared ? cleanVariances.length : (details?.comparison?.diff_count || 0),
                clean_variances: isWaitingBrowserAct || isSkipped ? [] : cleanVariances,
            };
        });

        const avgDurationSeconds = durationRunCount > 0 ? (totalDurationMs / durationRunCount / 1000).toFixed(1) : '0';
        
        // Quota: Free tier is 6 hours = 21,600 seconds per month
        const estimatedMonthlySeconds = parseFloat(avgDurationSeconds) * 30 * 2;
        const quotaUsedPercent = ((estimatedMonthlySeconds / 21600) * 100).toFixed(2);

        // Comparable Morning Verification Pass Rate (capped cleanly at 100.0%)
        const comparableMorningRuns = history.filter(h =>
            ['PASS_ROUND_1_MATCH', 'PASS_ROUND_2_MATCH', 'PASS_USD_TIER_DIFF', 'VARIANCE_DETECTED'].includes(h.normalized_status)
        );
        const round1PassRate = comparableMorningRuns.length > 0
            ? Math.min(100, (passCount / comparableMorningRuns.length) * 100).toFixed(1)
            : '100.0';

        const round1Count = history.filter(h => h.round === '1' && h.normalized_status !== 'STALE_DATE_SKIPPED').length;
        const round2Count = history.filter(h => h.round === '2' && h.normalized_status !== 'STALE_DATE_SKIPPED').length;

        const summaryData = {
            title: 'KBANK Shadow Parallel Verification Report (Browserless vs BrowserAct)',
            metrics: {
                total_runs: totalRuns,
                same_round_pass_count: passCount,
                comparable_morning_runs: comparableMorningRuns.length,
                cross_round_tests: crossRoundCount,
                stale_retry_count: staleRetryCount,
                waiting_browseract_count: waitingCount,
                retroactive_matched_count: retroMatchedCount,
                failed_count: failCount,
                round1_match_rate: `${round1PassRate}%`,
                avg_fetch_duration: `${avgDurationSeconds}s`,
                estimated_monthly_quota_used: `${quotaUsedPercent}% of 6-hour Free Tier`,
                head_to_head: {
                    round_1_runs: round1Count,
                    round_2_runs: round2Count,
                    browserless_finished_first_count: browserlessFirstCount,
                },
            },
            history,
        };

        if (wantsHtml) {
            return new NextResponse(renderHtml(summaryData), {
                headers: { 'Content-Type': 'text/html; charset=utf-8' },
            });
        }

        return NextResponse.json(summaryData);

    } catch (err: any) {
        return NextResponse.json({ error: err.message }, { status: 500 });
    }
}

function renderHtml(data: any): string {
    const { metrics, history } = data;

    const rowsHtml = history.map((h: any, i: number) => {
        let badgeColor = '#22c55e';
        let badgeText = '✅ 100% Match';

        if (h.normalized_status === 'PASS_ROUND_1_MATCH') {
            badgeColor = '#22c55e';
            badgeText = '✅ 100% Match (Round 1)';
        } else if (h.normalized_status === 'PASS_ROUND_2_MATCH') {
            badgeColor = '#10b981';
            badgeText = '✅ 100% Match (Round 2)';
        } else if (h.normalized_status === 'PASS_USD_TIER_DIFF') {
            badgeColor = '#3b82f6';
            badgeText = '🔹 100% TT Match (USD $50-100)';
        } else if (h.normalized_status === 'AFTERNOON_ROUND_SKIPPED') {
            badgeColor = '#f59e0b';
            badgeText = `⚠️ Afternoon (Round ${h.round} Skipped)`;
        } else if (h.normalized_status === 'STALE_DATE_SKIPPED') {
            badgeColor = '#94a3b8';
            badgeText = '⏭ Stale Date (Retry)';
        } else if (h.normalized_status === 'WAITING_BROWSERACT') {
            badgeColor = '#0ea5e9';
            badgeText = '⏳ Waiting BrowserAct';
        } else if (h.normalized_status === 'VARIANCE_DETECTED') {
            badgeColor = '#f97316';
            badgeText = '⚠️ Variance Detected';
        } else if (h.normalized_status === 'FAILED') {
            badgeColor = '#ef4444';
            badgeText = '❌ Selector Timeout';
        }

        const dateStr = h.tested_at ? new Date(h.tested_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-';
        const baFetchedStr = h.browseract_fetched_at
            ? new Date(h.browseract_fetched_at).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })
            : null;

        let headToHeadHtml = '';
        if (h.head_to_head_lead_seconds !== null && h.head_to_head_lead_seconds !== undefined) {
            const absSec = Math.abs(h.head_to_head_lead_seconds);
            const fmtDelta = absSec >= 60 ? `${Math.floor(absSec / 60)}m ${absSec % 60}s` : `${absSec}s`;
            if (h.head_to_head_lead_seconds > 0) {
                headToHeadHtml = `<div style="font-size:10px;color:#22c55e;margin-top:2px;">⚡ BL faster by ${fmtDelta}${baFetchedStr ? ` (BA ${baFetchedStr})` : ''}</div>`;
            } else if (h.head_to_head_lead_seconds < 0) {
                headToHeadHtml = `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">BA earlier by ${fmtDelta}${baFetchedStr ? ` (${baFetchedStr})` : ''}</div>`;
            } else {
                headToHeadHtml = `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">Same second${baFetchedStr ? ` (${baFetchedStr})` : ''}</div>`;
            }
        } else if (baFetchedStr) {
            headToHeadHtml = `<div style="font-size:10px;color:#94a3b8;margin-top:2px;">BA fetched ${baFetchedStr}</div>`;
        }

        const roundDetailHtml = `
            <div style="font-weight:700;color:#f8fafc;">Round ${h.round}${h.retroactively_compared ? ' <span style="font-size:10px;color:#38bdf8;font-weight:600;">(Retro)</span>' : ''}</div>
            <div style="font-size:10px;color:#64748b;font-family:monospace;margin-top:2px;">BL: ${h.browserless_timestamp} | BA: ${h.browseract_timestamp}</div>
        `;

        const diffCellHtml = h.normalized_status === 'STALE_DATE_SKIPPED'
            ? '<span style="color:#94a3b8;">Skipped (waiting today\'s rate)</span>'
            : h.normalized_status === 'WAITING_BROWSERACT'
                ? '<span style="color:#0ea5e9;">Pending BrowserAct data</span>'
                : h.effective_diff_count === 0
                    ? '<span style="color:#22c55e;">0 diffs (100% Match)</span>'
                    : `<span style="color:${badgeColor};">${h.effective_diff_count} diffs</span>`;

        return `
            <tr>
                <td style="color:#64748b;">${h.id}</td>
                <td>${dateStr}</td>
                <td><span style="display:inline-block;padding:2px 8px;border-radius:6px;background:${badgeColor}22;color:${badgeColor};font-weight:700;font-size:11px;">${badgeText}</span></td>
                <td>${roundDetailHtml}</td>
                <td style="color:#38bdf8;font-family:monospace;">${h.duration_seconds}s${headToHeadHtml}</td>
                <td>${h.currencies_checked}</td>
                <td>${diffCellHtml}</td>
            </tr>
        `;
    }).join('');

    return `<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>KBANK Shadow Test Report</title>
    <style>
        body { margin:0; padding:20px; background:#0a0e1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; }
        .wrap { max-width:1100px; margin:0 auto; }
        .hdr { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #1e293b; padding-bottom:16px; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
        h1 { margin:0; font-size:22px; font-weight:800; color:#f8fafc; display:flex; align-items:center; gap:10px; }
        .btn { background:linear-gradient(135deg,#6366f1,#818cf8); color:white; text-decoration:none; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:600; display:inline-block; }
        .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; margin-bottom:24px; }
        .card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:16px; }
        .card .lbl { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; margin-bottom:6px; }
        .card .val { font-size:28px; font-weight:800; }
        .card .sub { font-size:11px; color:#64748b; margin-top:4px; }
        .callout { background:rgba(34,197,94,0.1); border:1px solid rgba(34,197,94,0.3); border-radius:10px; padding:16px; margin-bottom:24px; line-height:1.5; font-size:13px; }
        table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:12px; overflow:hidden; font-size:13px; }
        th { background:#0f172a; padding:12px 14px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; border-bottom:1px solid #334155; }
        td { padding:10px 14px; border-bottom:1px solid rgba(51,65,85,0.4); }
        tr:hover { background:rgba(99,102,241,0.06); }
        .json-link { font-size:12px; color:#818cf8; text-decoration:none; margin-left:12px; }
        .json-link:hover { text-decoration:underline; }
        code { background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:12px; }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="hdr">
            <div>
                <h1>⚡ KBANK Shadow Test Verification</h1>
                <div style="font-size:12px;color:#94a3b8;margin-top:4px;">
                    ทดสอบคู่ขนาน Browserless.io (Stealth Remote Chrome) เทียบกับ BrowserAct
                    <a class="json-link" href="?format=json">ดู JSON API</a>
                </div>
            </div>
            <a class="btn" href="/">← กลับหน้าหลัก</a>
        </div>

        <div class="cards">
            <div class="card">
                <div class="lbl">Total Runs</div>
                <div class="val" style="color:#f8fafc;">${metrics.total_runs}</div>
                <div class="sub">Comparable: ${metrics.comparable_morning_runs} • Stale Retries: ${metrics.stale_retry_count}</div>
            </div>
            <div class="card">
                <div class="lbl">Morning Match Rate</div>
                <div class="val" style="color:#22c55e;">${metrics.round1_match_rate}</div>
                <div class="sub">R1: ${metrics.head_to_head?.round_1_runs ?? 0} • R2: ${metrics.head_to_head?.round_2_runs ?? 0} • BL First: ${metrics.head_to_head?.browserless_finished_first_count ?? 0}</div>
            </div>
            <div class="card">
                <div class="lbl">Avg Latency</div>
                <div class="val" style="color:#38bdf8;">${metrics.avg_fetch_duration}</div>
                <div class="sub">Retro Matched: ${metrics.retroactive_matched_count} • Waiting BA: ${metrics.waiting_browseract_count}</div>
            </div>
            <div class="card">
                <div class="lbl">Quota Consumption</div>
                <div class="val" style="color:#a855f7;">${metrics.estimated_monthly_quota_used}</div>
                <div class="sub">ใช้ Free Tier $0/เดือน</div>
            </div>
        </div>

        <div class="callout">
            <strong style="color:#22c55e;">📌 ระเบียบการจัดเก็บและทดสอบ Shadow Test (Active Policy):</strong><br>
            1. <strong>เก็บข้อมูลเหมือนกัน 100%:</strong> บันทึกค่า <code>0</code> แทน <code>null</code> ในสกุลเงินที่ไม่มีเรทธนบัตร/ตั๋วเงิน (เช่น AED, BHD, DKK) และบันทึกประเภท <code>USD (50-100)</code> เหมือน BrowserAct ทุกประการ<br>
            2. <strong>รอบเช้าเท่านั้น (08:00 - 10:59 ICT):</strong> จำกัดการรันเฉพาะรอบเช้าเพื่อไม่ให้มีเรทบ่ายมาปะปน<br>
            3. <strong>รันคู่ขนานอิสระตั้งแต่ 08:25 ICT &amp; ล็อกเรทเช้า:</strong> Shadow ทำงานคู่ขนานแบบอิสระกับ BrowserAct ตั้งแต่เวลา 08:25 ICT (เทียบย้อนหลังอัตโนมัติหาก Browserless เสร็จก่อน) และจะล็อกผลทันทีเมื่อเก็บเรทเช้าของวันนั้นสำเร็จแล้ว
        </div>

        <div style="overflow-x:auto;">
            <table>
                <thead>
                    <tr>
                        <th>ID</th>
                        <th>วัน-เวลาทดสอบ</th>
                        <th>สถานะการเปรียบเทียบ</th>
                        <th>รอบธนาคาร / เวลาเรท</th>
                        <th>ความเร็ว / Head-to-Head</th>
                        <th>สกุลเงิน</th>
                        <th>ผลการตรวจสอบ</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    </div>
</body>
</html>`;
}
