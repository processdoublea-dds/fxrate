'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';

// ============ Types ============
interface RateRecord {
    bank: string;
    currency: string;
    sell_tt: number;
    sell_notes: number;
    buy_tt: number;
    buy_sight: number;
    buy_transfer: number;
    buy_notes: number;
    currency_web: string;
    timestamp_bank: string;
}

interface FieldDiff {
    field: string;
    ref: number;
    sys: number;
    diff: number;
    pctDiff: number;
}

interface Comparison {
    bank: string;
    currency: string;
    status: 'match' | 'close' | 'diff' | 'missing_ref' | 'missing_sys';
    currency_web: string;
    maxPctDiff: number;
    fields: FieldDiff[];
}

interface Summary {
    totalRecords: number;
    totalFields: number;
    matchFields: number;
    diffFields: number;
    missingInRef: number;
    missingInSys: number;
    matchPct: number;
}

// ============ Config ============
const REF_URL =
    'https://script.google.com/macros/s/AKfycbzwUsEKgygTeAy7UHdM6_G69nLmC_7Ee_WLqPR38T1qnnyTWldWM_EVQY1-_X4NJkCnvA/exec';

const RATE_FIELDS = ['sell_tt', 'sell_notes', 'buy_tt', 'buy_sight', 'buy_transfer', 'buy_notes'] as const;

const FIELD_LABELS: Record<string, string> = {
    sell_tt: 'Sell TT',
    sell_notes: 'Sell Notes',
    buy_tt: 'Buy TT',
    buy_sight: 'Buy Sight',
    buy_transfer: 'Buy Xfer',
    buy_notes: 'Buy Notes',
};

function getTodayThai(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

// ============ Diff Logic ============
function compareRates(refData: RateRecord[], sysData: RateRecord[]): { summary: Summary; comparisons: Comparison[] } {
    const refMap = new Map<string, RateRecord>();
    for (const r of refData) refMap.set(`${r.bank}|${r.currency}`, r);

    const sysMap = new Map<string, RateRecord>();
    for (const r of sysData) sysMap.set(`${r.bank}|${r.currency}`, r);

    const allKeys = new Set([...refMap.keys(), ...sysMap.keys()]);
    const comparisons: Comparison[] = [];
    let totalFields = 0, matchFields = 0, diffFields = 0, missingInRef = 0, missingInSys = 0;

    for (const key of [...allKeys].sort()) {
        const [bank, currency] = key.split('|');
        const ref = refMap.get(key);
        const sys = sysMap.get(key);

        if (!ref) { missingInRef++; comparisons.push({ bank, currency, status: 'missing_ref', currency_web: sys?.currency_web || '', maxPctDiff: 0, fields: [] }); continue; }
        if (!sys) { missingInSys++; comparisons.push({ bank, currency, status: 'missing_sys', currency_web: ref.currency_web || '', maxPctDiff: 0, fields: [] }); continue; }

        const fields: FieldDiff[] = RATE_FIELDS.map((field) => {
            const refVal = ref[field] ?? 0;
            const sysVal = sys[field] ?? 0;
            const diff = sysVal - refVal;
            const pctDiff = refVal !== 0 ? ((diff / refVal) * 100) : (sysVal !== 0 ? 100 : 0);
            totalFields++;
            if (Math.abs(pctDiff) < 0.01) matchFields++; else diffFields++;
            return { field, ref: refVal, sys: sysVal, diff: Number(diff.toFixed(6)), pctDiff: Number(pctDiff.toFixed(4)) };
        });

        const maxPctDiff = Math.max(...fields.map((f) => Math.abs(f.pctDiff)));
        comparisons.push({
            bank, currency,
            status: maxPctDiff < 0.01 ? 'match' : maxPctDiff < 1 ? 'close' : 'diff',
            currency_web: ref.currency_web || sys.currency_web || '',
            maxPctDiff: Number(maxPctDiff.toFixed(4)),
            fields,
        });
    }

    return {
        summary: {
            totalRecords: comparisons.length, totalFields, matchFields, diffFields,
            missingInRef, missingInSys,
            matchPct: totalFields > 0 ? Number(((matchFields / totalFields) * 100).toFixed(2)) : 0,
        },
        comparisons,
    };
}

// ============ Component ============
export default function ComparePage() {
    const [date, setDate] = useState(getTodayThai());
    const [summary, setSummary] = useState<Summary | null>(null);
    const [comparisons, setComparisons] = useState<Comparison[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [filterBank, setFilterBank] = useState('ALL');
    const [filterStatus, setFilterStatus] = useState('ALL');
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    const fetchComparison = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Fetch both in parallel from client side
            const [refRes, sysRes] = await Promise.all([
                fetch(REF_URL),
                fetch(`/api/export?date=${date}`),
            ]);
            const refData = (await refRes.json()) as { data: RateRecord[] };
            const sysData = (await sysRes.json()) as { data: RateRecord[] };

            const result = compareRates(refData.data || [], sysData.data || []);
            setSummary(result.summary);
            setComparisons(result.comparisons);
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [date]);

    useEffect(() => { fetchComparison(); }, [fetchComparison]);

    const filtered = comparisons.filter((c) => {
        if (filterBank !== 'ALL' && c.bank !== filterBank) return false;
        if (filterStatus !== 'ALL' && c.status !== filterStatus) return false;
        return true;
    });

    const statusColor = (s: string) => ({ match: '#22c55e', close: '#f59e0b', diff: '#ef4444', missing_ref: '#a855f7', missing_sys: '#ec4899' }[s] || '#6b7280');
    const statusLabel = (s: string) => ({ match: '✅ Match', close: '⚠️ Close', diff: '❌ Diff', missing_ref: '🟣 No Ref', missing_sys: '🟡 No Sys' }[s] || s);
    const diffColor = (pct: number) => { const a = Math.abs(pct); return a < 0.01 ? '#22c55e' : a < 0.5 ? '#a3e635' : a < 1 ? '#f59e0b' : a < 5 ? '#f97316' : '#ef4444'; };
    const formatRate = (v: number) => v === 0 ? '—' : v < 0.01 ? v.toFixed(6) : v < 1 ? v.toFixed(5) : v.toFixed(4);

    return (
        <div className="cp">
            <style>{`
                .cp { min-height:100vh; background:#0a0e1a; color:#e2e8f0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:20px; }
                .cp-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; flex-wrap:wrap; gap:12px; }
                .cp-hdr h1 { font-size:22px; font-weight:700; color:#f8fafc; display:flex; align-items:center; gap:10px; }
                .cp-hdr h1 a { font-size:13px; color:#818cf8; text-decoration:none; font-weight:500; }
                .cp-hdr h1 a:hover { text-decoration:underline; }
                .ctrl { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
                .ctrl input,.ctrl select { background:#1e293b; border:1px solid #334155; color:#e2e8f0; padding:8px 14px; border-radius:8px; font-size:13px; font-family:inherit; }
                .ctrl button { background:linear-gradient(135deg,#6366f1,#818cf8); color:white; border:none; padding:8px 18px; border-radius:8px; font-weight:600; cursor:pointer; font-size:13px; font-family:inherit; }
                .ctrl button:disabled { opacity:.5; cursor:not-allowed; }
                .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:12px; margin-bottom:20px; }
                .card { background:#1e293b; border:1px solid #334155; border-radius:12px; padding:14px; text-align:center; }
                .card .lb { font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:#94a3b8; margin-bottom:4px; }
                .card .vl { font-size:26px; font-weight:800; }
                .tbl { width:100%; border-collapse:collapse; font-size:12px; background:#1e293b; border-radius:12px; overflow:hidden; }
                .tbl th { background:#0f172a; padding:10px 8px; text-align:center; font-weight:600; color:#94a3b8; font-size:10px; text-transform:uppercase; letter-spacing:.5px; border-bottom:1px solid #334155; position:sticky; top:0; z-index:2; }
                .tbl th:nth-child(-n+3) { text-align:left; }
                .tbl td { padding:7px 8px; border-bottom:1px solid rgba(51,65,85,.5); text-align:center; font-family:'SF Mono','Fira Code',monospace; font-size:11.5px; }
                .tbl td:nth-child(-n+3) { text-align:left; font-family:inherit; }
                .tbl tr:hover { background:rgba(99,102,241,.08); }
                .tbl tr.exp { background:rgba(99,102,241,.05); }
                .bb { display:inline-block; padding:2px 8px; border-radius:4px; font-size:10px; font-weight:700; }
                .sp { display:inline-block; padding:3px 10px; border-radius:12px; font-size:10px; font-weight:600; }
                .dtr td { padding:0!important; border:none!important; }
                .dg { display:grid; grid-template-columns:repeat(6,1fr); gap:8px; padding:12px 16px; background:rgba(15,23,42,.6); }
                .dc { background:#1e293b; border:1px solid #334155; border-radius:8px; padding:10px; text-align:center; }
                .dc .fn { font-size:10px; color:#94a3b8; text-transform:uppercase; margin-bottom:8px; }
                .dc .rr { display:flex; justify-content:space-between; font-size:11px; margin:3px 0; }
                .dc .rl { color:#64748b; }
                .dc .rv { font-family:'SF Mono','Fira Code',monospace; }
                .dc .dr { margin-top:6px; padding-top:6px; border-top:1px solid #334155; font-weight:700; font-size:12px; }
                .ptr { cursor:pointer; }
                .ld { display:flex; justify-content:center; align-items:center; padding:60px; font-size:18px; color:#94a3b8; }
                .err { background:rgba(239,68,68,.15); color:#fca5a5; padding:16px; border-radius:12px; margin-bottom:20px; }
                @keyframes spin { to { transform:rotate(360deg); } }
                .spn { display:inline-block; animation:spin 1s linear infinite; }
            `}</style>

            <div className="cp-hdr">
                <h1>📊 Rate Comparison <Link href="/">← Dashboard</Link></h1>
                <div className="ctrl">
                    <input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={getTodayThai()} />
                    <select value={filterBank} onChange={(e) => setFilterBank(e.target.value)}>
                        <option value="ALL">All Banks</option>
                        <option value="SCB">SCB</option>
                        <option value="KTB">KTB</option>
                        <option value="KBANK">KBANK</option>
                        <option value="BOT">BOT</option>
                    </select>
                    <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
                        <option value="ALL">All Status</option>
                        <option value="match">✅ Match</option>
                        <option value="close">⚠️ Close</option>
                        <option value="diff">❌ Diff</option>
                    </select>
                    <button onClick={fetchComparison} disabled={loading}>
                        {loading ? <><span className="spn">⟳</span> Loading...</> : '🔄 Refresh'}
                    </button>
                </div>
            </div>

            {error && <div className="err">❌ {error}</div>}

            {loading ? (
                <div className="ld"><span className="spn" style={{ fontSize: 40 }}>⟳</span></div>
            ) : summary ? (
                <>
                    <div className="cards">
                        <div className="card"><div className="lb">Records</div><div className="vl" style={{ color: '#e2e8f0' }}>{summary.totalRecords}</div></div>
                        <div className="card"><div className="lb">Match Rate</div><div className="vl" style={{ color: summary.matchPct > 80 ? '#22c55e' : '#f59e0b' }}>{summary.matchPct}%</div></div>
                        <div className="card"><div className="lb">Exact Match</div><div className="vl" style={{ color: '#22c55e' }}>{summary.matchFields}</div></div>
                        <div className="card"><div className="lb">Diff Fields</div><div className="vl" style={{ color: '#ef4444' }}>{summary.diffFields}</div></div>
                        <div className="card"><div className="lb">Missing Ref</div><div className="vl" style={{ color: '#a855f7' }}>{summary.missingInRef}</div></div>
                        <div className="card"><div className="lb">Missing Sys</div><div className="vl" style={{ color: '#ec4899' }}>{summary.missingInSys}</div></div>
                    </div>

                    <table className="tbl">
                        <thead>
                            <tr>
                                <th>#</th><th>Bank</th><th>CCY</th><th>Status</th><th>Max Diff</th>
                                {Object.entries(FIELD_LABELS).map(([k, v]) => <th key={k}>{v}</th>)}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((c, i) => {
                                const rk = `${c.bank}|${c.currency}`;
                                const isExp = expandedRow === rk;
                                const bc = c.bank === 'SCB' ? '#c084fc' : c.bank === 'KTB' ? '#60a5fa' : c.bank === 'KBANK' ? '#4ade80' : '#fbbf24';
                                return (
                                    <>
                                        <tr key={rk} className={`ptr ${isExp ? 'exp' : ''}`} onClick={() => setExpandedRow(isExp ? null : rk)}>
                                            <td style={{ color: '#64748b' }}>{i + 1}</td>
                                            <td><span className="bb" style={{ background: `${bc}22`, color: bc }}>{c.bank}</span></td>
                                            <td style={{ fontWeight: 700, color: '#f8fafc' }}>{c.currency}</td>
                                            <td><span className="sp" style={{ background: `${statusColor(c.status)}22`, color: statusColor(c.status) }}>{statusLabel(c.status)}</span></td>
                                            <td style={{ color: diffColor(c.maxPctDiff), fontWeight: 700 }}>{c.maxPctDiff ? `${c.maxPctDiff.toFixed(2)}%` : '—'}</td>
                                            {c.fields.length > 0 ? c.fields.map((f) => (
                                                <td key={f.field} style={{ color: diffColor(f.pctDiff) }}>
                                                    {Math.abs(f.pctDiff) < 0.01 ? '✓' : `${f.pctDiff > 0 ? '+' : ''}${f.pctDiff.toFixed(2)}%`}
                                                </td>
                                            )) : <td colSpan={6} style={{ color: '#64748b' }}>—</td>}
                                        </tr>
                                        {isExp && c.fields.length > 0 && (
                                            <tr key={`${rk}-d`} className="dtr">
                                                <td colSpan={11}>
                                                    <div className="dg">
                                                        {c.fields.map((f) => (
                                                            <div className="dc" key={f.field}>
                                                                <div className="fn">{FIELD_LABELS[f.field]}</div>
                                                                <div className="rr"><span className="rl">Ref:</span><span className="rv">{formatRate(f.ref)}</span></div>
                                                                <div className="rr"><span className="rl">Sys:</span><span className="rv" style={{ color: diffColor(f.pctDiff) }}>{formatRate(f.sys)}</span></div>
                                                                <div className="dr" style={{ color: diffColor(f.pctDiff) }}>
                                                                    {f.diff > 0 ? '+' : ''}{formatRate(f.diff)} ({f.pctDiff > 0 ? '+' : ''}{f.pctDiff.toFixed(2)}%)
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </>
                                );
                            })}
                        </tbody>
                    </table>
                </>
            ) : null}
        </div>
    );
}
