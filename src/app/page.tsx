'use client';

import { useState, useEffect, useCallback } from 'react';

interface RateRow {
  id: number;
  run_id: string;
  source: string;
  currency: string;
  currency_label: string;
  sell_tt: number | null;
  sell_notes: number | null;
  buy_tt: number | null;
  buy_sight: number | null;
  buy_transfer: number | null;
  buy_notes: number | null;
  mid_rate: number | null;
  bank_timestamp: string | null;
  fetched_at: string | null;
  rate_date: string;
}

interface SourceSummary {
  source: string;
  count: number;
  status: string;
  lastFetch: string | null;
  durationMs: number | null;
  botDate?: string;
}

interface ApiResponse {
  date: string;
  botDate: string;
  rates: RateRow[];
  summary: SourceSummary[];
}

interface Toast {
  message: string;
  type: 'success' | 'error';
  id: number;
}

// Source cards: BOT (includes Bloomberg), SCB, KTB, KBANK
const SOURCE_CARDS = ['BOT', 'SCB', 'KTB', 'KBANK'];

// For manual fetch — all 5 actual sources
const FETCH_SOURCES = ['BOT', 'BLOOMBERG', 'SCB', 'KTB', 'KBANK'];

// Display order for sources in table
const SOURCE_ORDER = ['SCB', 'KTB', 'KBANK', 'BOT'];

export default function Dashboard() {
  const [date, setDate] = useState(getTodayThai());
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchingSource, setFetchingSource] = useState<string | null>(null);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [search, setSearch] = useState('');
  const [filterSource, setFilterSource] = useState<string>('ALL');
  const [toasts, setToasts] = useState<Toast[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/rates?date=${date}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to fetch rates:', err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  function addToast(message: string, type: 'success' | 'error') {
    const id = Date.now();
    setToasts((prev) => [...prev, { message, type, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }

  async function handleFetchSource(source: string) {
    setFetchingSource(source);
    try {
      const res = await fetch('/api/fetch-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const json = await res.json();
      if (json.success) {
        addToast(`✓ ${source}: ${json.recordsCount} currencies (${(json.durationMs / 1000).toFixed(1)}s)`, 'success');
        await fetchData();
      } else {
        addToast(`✕ ${source}: ${json.error}`, 'error');
      }
    } catch (err) {
      addToast(`✕ ${source}: ${err instanceof Error ? err.message : 'Failed'}`, 'error');
    } finally {
      setFetchingSource(null);
    }
  }

  async function handleFetchBotBloomberg() {
    setFetchingSource('BOT');
    try {
      const botRes = await fetch('/api/fetch-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'BOT' }),
      });
      const botJson = await botRes.json();
      if (botJson.success) {
        addToast(`✓ BOT: ${botJson.recordsCount} currencies`, 'success');
      } else {
        addToast(`✕ BOT: ${botJson.error}`, 'error');
      }

      const bbRes = await fetch('/api/fetch-single', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'BLOOMBERG' }),
      });
      const bbJson = await bbRes.json();
      if (bbJson.success) {
        addToast(`✓ Bloomberg: ${bbJson.recordsCount} currencies`, 'success');
      } else {
        addToast(`✕ Bloomberg: ${bbJson.error}`, 'error');
      }

      await fetchData();
    } catch (err) {
      addToast(`✕ BOT/Bloomberg: ${err instanceof Error ? err.message : 'Failed'}`, 'error');
    } finally {
      setFetchingSource(null);
    }
  }

  async function handleFetchAll() {
    setFetchingAll(true);
    for (const source of FETCH_SOURCES) {
      await handleFetchSource(source);
    }
    setFetchingAll(false);
  }

  function changeDate(delta: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().split('T')[0]);
  }

  // Build flat raw data rows
  const tableRows = buildRawTableData(data?.rates || [], search, filterSource);
  const botDate = data?.botDate;

  return (
    <>
      {/* Header */}
      <header className="header">
        <h1>
          <span>💱</span> FX Rate Monitor
        </h1>
        <div className="date-picker">
          <button onClick={() => changeDate(-1)} title="Previous day">◀</button>
          <div className="date-input-wrapper">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={getTodayThai()}
            />
          </div>
          <button onClick={() => changeDate(1)} title="Next day" disabled={date >= getTodayThai()}>▶</button>
        </div>
      </header>

      <main className="main-content">
        {/* Source Status Cards — 4 cards */}
        <div className="source-cards four-cols">
          {SOURCE_CARDS.map((source) => {
            const summary = data?.summary?.find((s) => s.source === source);
            const count = summary?.count || 0;
            const status = summary?.status || 'none';
            const isFetching = fetchingSource === source || (source === 'BOT' && fetchingSource === 'BLOOMBERG');

            const cardLabel = source === 'BOT'
              ? `BOT / Bloomberg`
              : source;

            const dateLabel = source === 'BOT' && botDate
              ? `Data: ${formatShortDate(botDate)}`
              : null;

            return (
              <div className="source-card" key={source}>
                <div className="card-header">
                  <span className="source-name">{cardLabel}</span>
                  <span className={`status-badge ${status === 'success' ? 'success' : status === 'partial' || status === 'failed' ? 'warning' : 'none'}`}>
                    {status === 'success' ? '✓ Success' : status === 'partial' ? '⚠ Partial' : status === 'failed' ? '✕ Failed' : status === 'running' ? '⟳ Running' : '— None'}
                  </span>
                </div>
                <div className="rate-count">{count}</div>
                <div className="rate-label">currencies fetched</div>
                <div className="fetch-time">
                  {dateLabel && <div style={{ color: 'var(--accent-light)', marginBottom: 2 }}>{dateLabel}</div>}
                  {summary?.lastFetch
                    ? `Last: ${formatTime(summary.lastFetch)}`
                    : 'Not fetched today'}
                </div>
                <button
                  className={`fetch-btn ${isFetching ? 'loading' : ''}`}
                  onClick={() => source === 'BOT' ? handleFetchBotBloomberg() : handleFetchSource(source)}
                  disabled={isFetching || fetchingAll}
                >
                  {isFetching ? (
                    <><span className="spinner">⟳</span> Fetching...</>
                  ) : (
                    <>⟳ Fetch Now</>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Toolbar */}
        <div className="toolbar">
          <div className="search-box">
            <span className="search-icon">🔍</span>
            <input
              type="text"
              placeholder="Search currency (e.g. USD, Euro...)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-group">
            <select
              className="source-filter"
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
            >
              <option value="ALL">All Sources</option>
              <option value="SCB">SCB</option>
              <option value="KTB">KTB</option>
              <option value="KBANK">KBANK</option>
              <option value="BOT">BOT</option>
            </select>
            <button
              className="fetch-all-btn"
              onClick={handleFetchAll}
              disabled={fetchingAll || fetchingSource !== null}
            >
              {fetchingAll ? (
                <><span className="spinner">⟳</span> Fetching All...</>
              ) : (
                <>⟳ Fetch All Sources</>
              )}
            </button>
            <button
              className="json-api-btn"
              onClick={() => window.open(`/api/export?date=${date}`, '_blank')}
              title="Open JSON API in new tab"
            >
              📋 JSON API
            </button>
            <button
              className="json-api-btn"
              onClick={() => window.open(`/compare`, '_blank')}
              title="Compare with reference data"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #a78bfa)' }}
            >
              📊 Compare
            </button>
          </div>
        </div>

        {/* Raw Data Table */}
        {loading ? (
          <div className="empty-state">
            <div className="icon"><span className="spinner" style={{ fontSize: '48px' }}>⟳</span></div>
            <h3>Loading rates...</h3>
          </div>
        ) : tableRows.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📊</div>
            <h3>No rates for {date}</h3>
            <p>Click &ldquo;Fetch All Sources&rdquo; to fetch rates</p>
          </div>
        ) : (
          <div className="rate-table-wrapper">
            <div className="table-info">
              <span>{tableRows.length} records</span>
              {botDate && <span className="bot-date-note">BOT data date: {botDate}</span>}
            </div>
            <table className="rate-table raw-table">
              <thead>
                <tr>
                  <th className="th-row">#</th>
                  <th className="th-bank">Bank</th>
                  <th className="th-ccy">Currency</th>
                  <th className="th-rate">Sell TT</th>
                  <th className="th-rate">Sell Notes</th>
                  <th className="th-rate">Buy TT</th>
                  <th className="th-rate">Buy Sight</th>
                  <th className="th-rate">Buy Transfer</th>
                  <th className="th-rate">Buy Notes</th>
                  <th className="th-label">Currency Name</th>
                  <th className="th-ts">Bank Timestamp</th>
                  <th className="th-ts">System Recorded</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((row, idx) => {
                  const isGroupStart = idx === 0 || tableRows[idx - 1].displaySource !== row.displaySource;
                  return (
                    <tr key={row.id} className={isGroupStart ? 'group-start' : ''}>
                      <td className="td-row">{idx + 1}</td>
                      <td className="td-bank">
                        <span className={`bank-tag bank-${row.displaySource.toLowerCase()}`}>
                          {row.displaySource}
                        </span>
                      </td>
                      <td className="td-ccy">
                        <span className="currency-code">{row.currency}</span>
                      </td>
                      <td className="td-rate">{fmtRate(row.sell_tt)}</td>
                      <td className="td-rate">{fmtRate(row.sell_notes)}</td>
                      <td className="td-rate">{fmtRate(row.buy_tt)}</td>
                      <td className="td-rate">{fmtRate(row.buy_sight)}</td>
                      <td className="td-rate">{fmtRate(row.buy_transfer)}</td>
                      <td className="td-rate">{fmtRate(row.buy_notes)}</td>
                      <td className="td-label">{row.currency_label}</td>
                      <td className="td-ts">{fmtTimestamp(row.bank_timestamp)}</td>
                      <td className="td-ts">{fmtTimestamp(row.fetched_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {/* Toast Notifications */}
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.type}`}>
          {toast.message}
        </div>
      ))}
    </>
  );
}

// --- Helpers ---

function getTodayThai(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function formatTime(isoStr: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Bangkok',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' ICT';
  } catch {
    return isoStr;
  }
}

function formatShortDate(dateStr: string): string {
  try {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  } catch {
    return dateStr;
  }
}

/** Format rate: show 5 decimal places, 0.00000 if null */
function fmtRate(val: number | null): string {
  if (val === null || val === undefined) return '0.00000';
  return val.toFixed(5);
}

/** Format timestamp to readable format */
function fmtTimestamp(ts: string | null): string {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    // Format: YYYY/MM/DD HH:mm:ss
    return d.toLocaleString('en-GB', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).replace(',', '');
  } catch {
    return ts;
  }
}

interface DisplayRow {
  id: number;
  displaySource: string; // BOT (includes BLOOMBERG)
  currency: string;
  currency_label: string;
  sell_tt: number | null;
  sell_notes: number | null;
  buy_tt: number | null;
  buy_sight: number | null;
  buy_transfer: number | null;
  buy_notes: number | null;
  bank_timestamp: string | null;
  fetched_at: string | null;
}

function buildRawTableData(rates: RateRow[], search: string, filterSource: string): DisplayRow[] {
  let rows: DisplayRow[] = rates.map((r) => ({
    id: r.id,
    displaySource: (r.source === 'BLOOMBERG') ? 'BOT' : r.source,
    currency: r.currency,
    currency_label: r.currency_label || '',
    sell_tt: r.sell_tt,
    sell_notes: r.sell_notes,
    buy_tt: r.buy_tt,
    buy_sight: r.buy_sight,
    buy_transfer: r.buy_transfer,
    buy_notes: r.buy_notes,
    bank_timestamp: r.bank_timestamp,
    fetched_at: r.fetched_at,
  }));

  // Filter by source
  if (filterSource !== 'ALL') {
    rows = rows.filter((r) => r.displaySource === filterSource);
  }

  // Filter by search
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.currency.toLowerCase().includes(q) ||
        r.currency_label.toLowerCase().includes(q)
    );
  }

  // Sort by source order (SCB → KTB → KBANK → BOT), then currency within each source
  rows.sort((a, b) => {
    const aOrder = SOURCE_ORDER.indexOf(a.displaySource);
    const bOrder = SOURCE_ORDER.indexOf(b.displaySource);
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.currency.localeCompare(b.currency);
  });

  return rows;
}
