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
}

interface ApiResponse {
  date: string;
  rates: RateRow[];
  summary: SourceSummary[];
}

interface Toast {
  message: string;
  type: 'success' | 'error';
  id: number;
}

const SOURCES = ['BOT', 'SCB', 'KTB', 'KBANK', 'BLOOMBERG'];

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
        addToast(`✓ ${source}: ${json.recordsCount} currencies fetched (${(json.durationMs / 1000).toFixed(1)}s)`, 'success');
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

  async function handleFetchAll() {
    setFetchingAll(true);
    for (const source of SOURCES) {
      await handleFetchSource(source);
    }
    setFetchingAll(false);
  }

  function changeDate(delta: number) {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().split('T')[0]);
  }

  // Build the comparison table data
  const tableData = buildTableData(data?.rates || [], search);

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
        {/* Source Status Cards */}
        <div className="source-cards">
          {SOURCES.map((source) => {
            const summary = data?.summary?.find((s) => s.source === source);
            const count = summary?.count || 0;
            const status = summary?.status || 'none';
            const isFetching = fetchingSource === source;

            return (
              <div className="source-card" key={source}>
                <div className="card-header">
                  <span className="source-name">{source}</span>
                  <span className={`status-badge ${status === 'success' ? 'success' : status === 'partial' || status === 'failed' ? 'warning' : 'none'}`}>
                    {status === 'success' ? '✓ Success' : status === 'partial' ? '⚠ Partial' : status === 'failed' ? '✕ Failed' : '— None'}
                  </span>
                </div>
                <div className="rate-count">{count}</div>
                <div className="rate-label">currencies fetched</div>
                <div className="fetch-time">
                  {summary?.lastFetch
                    ? `Last: ${formatTime(summary.lastFetch)}`
                    : 'Not fetched today'}
                </div>
                <button
                  className={`fetch-btn ${isFetching ? 'loading' : ''}`}
                  onClick={() => handleFetchSource(source)}
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
            <p>Click &ldquo;Fetch All Sources&rdquo; to fetch today&apos;s rates</p>
          </div>
        ) : (
          <div className="rate-table-wrapper">
            <table className="rate-table">
              <thead>
                <tr>
                  <th>Currency</th>
                  {SOURCES.map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tableData.map((row) => {
                  const values = SOURCES.map((s) => row.rates[s]);
                  const numericValues = values.filter((v): v is number => v !== null && v !== undefined);
                  const best = numericValues.length > 1 ? Math.min(...numericValues) : null;
                  const worst = numericValues.length > 1 ? Math.max(...numericValues) : null;

                  return (
                    <tr key={row.currency}>
                      <td>
                        <span className="currency-code">{row.currency}</span>
                        <span className="currency-label">{row.label}</span>
                      </td>
                      {SOURCES.map((s) => {
                        const val = row.rates[s];
                        if (val === null || val === undefined) {
                          return <td key={s} className="rate-na">—</td>;
                        }
                        const isBest = best !== null && val === best && numericValues.length > 1;
                        const isWorst = worst !== null && val === worst && numericValues.length > 1;
                        return (
                          <td
                            key={s}
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
  const now = new Date();
  const thai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
  return thai.toISOString().split('T')[0];
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
    // Use sell_tt as the comparison rate
    if (r.sell_tt !== null) {
      row.rates[r.source] = r.sell_tt;
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
