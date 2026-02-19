'use client';

import { useState, useEffect, useCallback } from 'react';

interface RateRow {
  id: number;
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

// Table columns: BOT/Bloomberg merged, SCB, KTB, KBANK
const TABLE_COLUMNS = ['BOT', 'SCB', 'KTB', 'KBANK'];

// For manual fetch — all 5 actual sources
const FETCH_SOURCES = ['BOT', 'BLOOMBERG', 'SCB', 'KTB', 'KBANK'];

export default function Dashboard() {
  const [date, setDate] = useState(getTodayThai());
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fetchingSource, setFetchingSource] = useState<string | null>(null);
  const [fetchingAll, setFetchingAll] = useState(false);
  const [search, setSearch] = useState('');
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
      // Fetch BOT
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

      // Fetch Bloomberg
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

  // Build the comparison table data — merge BOT + BLOOMBERG into one column
  const tableData = buildTableData(data?.rates || [], search);
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

            // BOT card shows the data date
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
        </div>

        {/* Rate Table */}
        {loading ? (
          <div className="empty-state">
            <div className="icon"><span className="spinner" style={{ fontSize: '48px' }}>⟳</span></div>
            <h3>Loading rates...</h3>
          </div>
        ) : tableData.length === 0 ? (
          <div className="empty-state">
            <div className="icon">📊</div>
            <h3>No rates for {date}</h3>
            <p>Click &ldquo;Fetch All Sources&rdquo; to fetch rates</p>
          </div>
        ) : (
          <div className="rate-table-wrapper">
            <table className="rate-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  {TABLE_COLUMNS.map((col) => (
                    <th key={col}>
                      {col === 'BOT' ? (
                        <span>
                          BOT
                          {botDate && <span className="col-date">{formatShortDate(botDate)}</span>}
                        </span>
                      ) : (
                        col
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.map((row) => {
                  const values = TABLE_COLUMNS.map((col) => row.rates[col]);
                  const numericValues = values.filter((v): v is number => v !== null && v !== undefined);
                  const best = numericValues.length > 1 ? Math.min(...numericValues) : null;
                  const worst = numericValues.length > 1 ? Math.max(...numericValues) : null;

                  return (
                    <tr key={row.currency}>
                      <td>
                        <span className="currency-code">{row.currency}</span>
                        <span className="currency-label">{row.label}</span>
                      </td>
                      {TABLE_COLUMNS.map((col) => {
                        const val = row.rates[col];
                        if (val === null || val === undefined) {
                          return <td key={col} className="rate-na">—</td>;
                        }
                        const isBest = best !== null && val === best && numericValues.length > 1;
                        const isWorst = worst !== null && val === worst && numericValues.length > 1;
                        return (
                          <td
                            key={col}
                            className={isBest ? 'rate-best' : isWorst ? 'rate-worst' : ''}
                          >
                            {formatRate(val)}
                          </td>
                        );
                      })}
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

function formatRate(val: number): string {
  if (val >= 1) return val.toFixed(4);
  if (val >= 0.01) return val.toFixed(5);
  return val.toFixed(6);
}

interface TableRow {
  currency: string;
  label: string;
  rates: Record<string, number | null>;
}

function buildTableData(rates: RateRow[], search: string): TableRow[] {
  const map = new Map<string, TableRow>();

  for (const r of rates) {
    const key = r.currency;
    if (!map.has(key)) {
      map.set(key, {
        currency: key,
        label: r.currency_label || '',
        rates: {},
      });
    }
    const row = map.get(key)!;

    // Merge BOT + BLOOMBERG into the BOT column
    const col = (r.source === 'BOT' || r.source === 'BLOOMBERG') ? 'BOT' : r.source;

    // Use sell_tt as the comparison rate; only set if not already set (BOT takes priority over Bloomberg)
    if (r.sell_tt !== null && (row.rates[col] === undefined || row.rates[col] === null)) {
      row.rates[col] = r.sell_tt;
    }

    // Keep the first non-empty label
    if (!row.label && r.currency_label) {
      row.label = r.currency_label;
    }
  }

  let rows = Array.from(map.values());

  // Filter by search
  if (search) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (r) =>
        r.currency.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q)
    );
  }

  // Sort: major currencies first, then alphabetical
  const priority = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'SGD', 'CHF', 'HKD', 'CAD'];
  rows.sort((a, b) => {
    const aIdx = priority.indexOf(a.currency);
    const bIdx = priority.indexOf(b.currency);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.currency.localeCompare(b.currency);
  });

  return rows;
}
