'use client';

import { useState, useEffect, useCallback } from 'react';

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
    maxPctDiff?: number;
    fields: FieldDiff[];
}

interface CompareResponse {
    date: string;
    refSource: string;
    sysSource: string;
    summary: {
        totalRecords: number;
        totalFields: number;
        matchFields: number;
        diffFields: number;
        missingInRef: number;
        missingInSys: number;
        matchPct: number;
    };
    comparisons: Comparison[];
}

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

export default function ComparePage() {
    const [date, setDate] = useState(getTodayThai());
    const [data, setData] = useState<CompareResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [filterBank, setFilterBank] = useState('ALL');
    const [filterStatus, setFilterStatus] = useState('ALL');
    const [expandedRow, setExpandedRow] = useState<string | null>(null);

    const fetchComparison = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/compare?date=${date}`);
            const json = await res.json();
            setData(json);
        } catch (err) {
            console.error('Compare failed:', err);
        } finally {
            setLoading(false);
        }
    }, [date]);

    useEffect(() => {
        fetchComparison();
    }, [fetchComparison]);

    const filtered = data?.comparisons.filter((c) => {
        if (filterBank !== 'ALL' && c.bank !== filterBank) return false;
        if (filterStatus !== 'ALL' && c.status !== filterStatus) return false;
        return true;
    }) || [];

    const statusColor = (status: string) => {
        switch (status) {
            case 'match': return '#22c55e';
            case 'close': return '#f59e0b';
            case 'diff': return '#ef4444';
            case 'missing_ref': return '#a855f7';
            case 'missing_sys': return '#ec4899';
            default: return '#6b7280';
        }
    };

    const statusLabel = (status: string) => {
        switch (status) {
            case 'match': return '✅ Match';
            case 'close': return '⚠️ Close (<1%)';
            case 'diff': return '❌ Diff (>1%)';
            case 'missing_ref': return '🟣 Missing (Ref)';
            case 'missing_sys': return '🟡 Missing (Sys)';
            default: return status;
        }
    };

    const diffColor = (pct: number) => {
        const abs = Math.abs(pct);
        if (abs < 0.01) return '#22c55e';
        if (abs < 0.5) return '#a3e635';
        if (abs < 1) return '#f59e0b';
        if (abs < 5) return '#f97316';
        return '#ef4444';
    };

    const formatRate = (val: number) => {
        if (val === 0) return '—';
        if (val < 0.01) return val.toFixed(6);
        if (val < 1) return val.toFixed(5);
        return val.toFixed(4);
    };

    return (
        <div className="compare-page">
            <style>{`
                .compare-page {
                    min-height: 100vh;
                    background: #0a0e1a;
                    color: #e2e8f0;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    padding: 20px;
                }
                .compare-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 20px;
                    flex-wrap: wrap;
                    gap: 12px;
                }
                .compare-header h1 {
                    font-size: 22px;
                    font-weight: 700;
                    color: #f8fafc;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                .compare-header h1 a {
                    font-size: 13px;
                    color: #818cf8;
                    text-decoration: none;
                    font-weight: 500;
                }
                .compare-header h1 a:hover { text-decoration: underline; }
                .controls {
                    display: flex;
                    gap: 10px;
                    align-items: center;
                }
                .controls input, .controls select {
                    background: #1e293b;
                    border: 1px solid #334155;
                    color: #e2e8f0;
                    padding: 8px 14px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-family: inherit;
                }
                .controls button {
                    background: linear-gradient(135deg, #6366f1, #818cf8);
                    color: white;
                    border: none;
                    padding: 8px 18px;
                    border-radius: 8px;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 13px;
                    font-family: inherit;
                }
                .controls button:disabled { opacity: 0.5; cursor: not-allowed; }
                .summary-cards {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                    gap: 12px;
                    margin-bottom: 20px;
                }
                .summary-card {
                    background: #1e293b;
                    border: 1px solid #334155;
                    border-radius: 12px;
                    padding: 16px;
                    text-align: center;
                }
                .summary-card .label {
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    color: #94a3b8;
                    margin-bottom: 4px;
                }
                .summary-card .value {
                    font-size: 28px;
                    font-weight: 800;
                }
                .compare-table {
                    width: 100%;
                    border-collapse: collapse;
                    font-size: 12px;
                    background: #1e293b;
                    border-radius: 12px;
                    overflow: hidden;
                }
                .compare-table th {
                    background: #0f172a;
                    padding: 10px 8px;
                    text-align: center;
                    font-weight: 600;
                    color: #94a3b8;
                    font-size: 11px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    border-bottom: 1px solid #334155;
                    position: sticky;
                    top: 0;
                    z-index: 2;
                }
                .compare-table th:first-child,
                .compare-table th:nth-child(2),
                .compare-table th:nth-child(3) { text-align: left; }
                .compare-table td {
                    padding: 8px;
                    border-bottom: 1px solid rgba(51, 65, 85, 0.5);
                    text-align: center;
                    font-family: 'SF Mono', 'Fira Code', monospace;
                    font-size: 11.5px;
                }
                .compare-table td:first-child,
                .compare-table td:nth-child(2),
                .compare-table td:nth-child(3) { text-align: left; }
                .compare-table tr:hover { background: rgba(99, 102, 241, 0.08); }
                .compare-table tr.expanded { background: rgba(99, 102, 241, 0.05); }
                .bank-badge {
                    display: inline-block;
                    padding: 2px 8px;
                    border-radius: 4px;
                    font-size: 10px;
                    font-weight: 700;
                    font-family: inherit;
                }
                .status-pill {
                    display: inline-block;
                    padding: 3px 10px;
                    border-radius: 12px;
                    font-size: 10px;
                    font-weight: 600;
                    font-family: inherit;
                }
                .detail-row td { padding: 0 !important; border: none !important; }
                .detail-grid {
                    display: grid;
                    grid-template-columns: repeat(6, 1fr);
                    gap: 8px;
                    padding: 12px 16px;
                    background: rgba(15, 23, 42, 0.6);
                    margin: 0;
                }
                .detail-cell {
                    background: #1e293b;
                    border: 1px solid #334155;
                    border-radius: 8px;
                    padding: 10px;
                    text-align: center;
                }
                .detail-cell .field-name {
                    font-size: 10px;
                    color: #94a3b8;
                    text-transform: uppercase;
                    margin-bottom: 8px;
                    font-family: inherit;
                }
                .detail-cell .rate-row {
                    display: flex;
                    justify-content: space-between;
                    font-size: 11px;
                    margin: 3px 0;
                }
                .detail-cell .rate-label {
                    color: #64748b;
                    font-family: inherit;
                }
                .detail-cell .rate-val {
                    font-family: 'SF Mono', 'Fira Code', monospace;
                }
                .detail-cell .diff-row {
                    margin-top: 6px;
                    padding-top: 6px;
                    border-top: 1px solid #334155;
                    font-weight: 700;
                    font-size: 12px;
                }
                .cursor-pointer { cursor: pointer; }
                .loading-state {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    padding: 60px;
                    font-size: 18px;
                    color: #94a3b8;
                }
                @keyframes spin { to { transform: rotate(360deg); } }
                .spinner { display: inline-block; animation: spin 1s linear infinite; }
            `}</style>

            <div className="compare-header">
                <h1>
                    📊 Rate Comparison
                    <a href="/">← Dashboard</a>
                </h1>
                <div className="controls">
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
                        {loading ? <><span className="spinner">⟳</span> Loading...</> : '🔄 Refresh'}
                    </button>
                </div>
            </div>

            {loading ? (
                <div className="loading-state"><span className="spinner" style={{ fontSize: 40 }}>⟳</span></div>
            ) : data ? (
                <>
                    {/* Summary Cards */}
                    <div className="summary-cards">
                        <div className="summary-card">
                            <div className="label">Total Records</div>
                            <div className="value" style={{ color: '#e2e8f0' }}>{data.summary.totalRecords}</div>
                        </div>
                        <div className="summary-card">
                            <div className="label">Match Rate</div>
                            <div className="value" style={{ color: data.summary.matchPct > 80 ? '#22c55e' : '#f59e0b' }}>
                                {data.summary.matchPct}%
                            </div>
                        </div>
                        <div className="summary-card">
                            <div className="label">Exact Match</div>
                            <div className="value" style={{ color: '#22c55e' }}>{data.summary.matchFields}</div>
                        </div>
                        <div className="summary-card">
                            <div className="label">Diff Fields</div>
                            <div className="value" style={{ color: '#ef4444' }}>{data.summary.diffFields}</div>
                        </div>
                        <div className="summary-card">
                            <div className="label">Ref Source</div>
                            <div className="value" style={{ color: '#818cf8', fontSize: 14 }}>{data.refSource}</div>
                        </div>
                        <div className="summary-card">
                            <div className="label">Sys Source</div>
                            <div className="value" style={{ color: '#06b6d4', fontSize: 14 }}>{data.sysSource}</div>
                        </div>
                    </div>

                    {/* Comparison Table */}
                    <table className="compare-table">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Bank</th>
                                <th>CCY</th>
                                <th>Status</th>
                                <th>Max Diff %</th>
                                {Object.entries(FIELD_LABELS).map(([key, label]) => (
                                    <th key={key}>{label}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {filtered.map((c, i) => {
                                const rowKey = `${c.bank}|${c.currency}`;
                                const isExpanded = expandedRow === rowKey;
                                const bankColor =
                                    c.bank === 'SCB' ? '#c084fc' :
                                        c.bank === 'KTB' ? '#60a5fa' :
                                            c.bank === 'KBANK' ? '#4ade80' :
                                                '#fbbf24';

                                return (
                                    <>
                                        <tr
                                            key={rowKey}
                                            className={`cursor-pointer ${isExpanded ? 'expanded' : ''}`}
                                            onClick={() => setExpandedRow(isExpanded ? null : rowKey)}
                                        >
                                            <td style={{ color: '#64748b', fontFamily: 'inherit' }}>{i + 1}</td>
                                            <td>
                                                <span className="bank-badge" style={{
                                                    background: `${bankColor}22`,
                                                    color: bankColor,
                                                }}>
                                                    {c.bank}
                                                </span>
                                            </td>
                                            <td style={{ fontWeight: 700, color: '#f8fafc' }}>{c.currency}</td>
                                            <td>
                                                <span className="status-pill" style={{
                                                    background: `${statusColor(c.status)}22`,
                                                    color: statusColor(c.status),
                                                }}>
                                                    {statusLabel(c.status)}
                                                </span>
                                            </td>
                                            <td style={{
                                                color: c.maxPctDiff !== undefined ? diffColor(c.maxPctDiff) : '#64748b',
                                                fontWeight: 700,
                                            }}>
                                                {c.maxPctDiff !== undefined ? `${c.maxPctDiff.toFixed(2)}%` : '—'}
                                            </td>
                                            {c.fields.length > 0 ? c.fields.map((f) => (
                                                <td key={f.field} style={{ color: diffColor(f.pctDiff) }}>
                                                    {f.pctDiff === 0 ? '✓' : `${f.pctDiff > 0 ? '+' : ''}${f.pctDiff.toFixed(2)}%`}
                                                </td>
                                            )) : (
                                                <td colSpan={6} style={{ color: '#64748b', fontFamily: 'inherit' }}>—</td>
                                            )}
                                        </tr>
                                        {isExpanded && c.fields.length > 0 && (
                                            <tr key={`${rowKey}-detail`} className="detail-row">
                                                <td colSpan={11}>
                                                    <div className="detail-grid">
                                                        {c.fields.map((f) => (
                                                            <div className="detail-cell" key={f.field}>
                                                                <div className="field-name">{FIELD_LABELS[f.field]}</div>
                                                                <div className="rate-row">
                                                                    <span className="rate-label">Ref:</span>
                                                                    <span className="rate-val">{formatRate(f.ref)}</span>
                                                                </div>
                                                                <div className="rate-row">
                                                                    <span className="rate-label">Sys:</span>
                                                                    <span className="rate-val" style={{ color: diffColor(f.pctDiff) }}>
                                                                        {formatRate(f.sys)}
                                                                    </span>
                                                                </div>
                                                                <div className="diff-row" style={{ color: diffColor(f.pctDiff) }}>
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
