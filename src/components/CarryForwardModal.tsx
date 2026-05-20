'use client';

import { useState, useEffect } from 'react';

interface CarryForwardModalProps {
  isOpen: boolean;
  targetDate: string;
  onSuccess: (count: number) => void;
  onCancel: () => void;
}

const SOURCES = ['SCB', 'KTB', 'KBANK', 'BOT'];

function getPrevWorkday(dateStr: string): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() - 1);
  // Skip weekends
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().split('T')[0];
}

export default function CarryForwardModal({ isOpen, targetDate, onSuccess, onCancel }: CarryForwardModalProps) {
  const [source, setSource] = useState('BOT');
  const [sourceDate, setSourceDate] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setSource('BOT');
      setSourceDate(getPrevWorkday(targetDate));
      setPin('');
      setError('');
      setSaving(false);
    }
  }, [isOpen, targetDate]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onCancel]);

  async function handleConfirm() {
    if (pin.length !== 4) {
      setError('Please enter your 4-digit PIN');
      return;
    }
    if (!sourceDate) {
      setError('Please select a source date');
      return;
    }
    if (sourceDate >= targetDate) {
      setError('Source date must be before target date');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/clone-rates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, source, sourceDate, targetDate }),
      });
      const json = await res.json();
      if (json.success) {
        onSuccess(json.count);
      } else {
        setError(json.error || 'Failed to carry forward rates');
        setPin('');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="edit-overlay" onClick={onCancel}>
      <div className="edit-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="edit-modal-header">
          <div className="edit-modal-title">
            <span className="edit-icon">📋</span>
            <div>
              <div className="edit-title-main">Carry Forward Rates</div>
              <div className="edit-title-sub" style={{ color: 'var(--amber)', fontSize: 12 }}>
                Use when API source is unavailable for <strong>{targetDate}</strong>
              </div>
            </div>
          </div>
          <button className="edit-close-btn" onClick={onCancel} type="button">✕</button>
        </div>

        {/* Info Banner */}
        <div className="carry-info-banner">
          <span>⚠️</span>
          <span>This will copy rates from a previous date into <strong>{targetDate}</strong>. Rates will be marked as carried-forward in raw_data.</span>
        </div>

        {/* Source + Date selection */}
        <div className="edit-fields-grid" style={{ gridTemplateColumns: '1fr 1fr', marginBottom: 0 }}>
          <div className="edit-field-group">
            <label className="edit-field-label">Source</label>
            <select
              className="edit-field-input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={saving}
              style={{ cursor: 'pointer', appearance: 'auto' }}
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>{s === 'BOT' ? 'BOT / Bloomberg' : s}</option>
              ))}
            </select>
          </div>
          <div className="edit-field-group">
            <label className="edit-field-label">Copy From Date</label>
            <input
              className="edit-field-input"
              type="date"
              value={sourceDate}
              max={new Date(targetDate + 'T00:00:00').toISOString().split('T')[0]}
              onChange={(e) => { setSourceDate(e.target.value); setError(''); }}
              disabled={saving}
            />
          </div>
        </div>

        <div className="carry-arrow-label">
          <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
            Copy <strong>{source === 'BOT' ? 'BOT + Bloomberg' : source}</strong> rates
            from <strong>{sourceDate || '—'}</strong> → <strong>{targetDate}</strong>
          </span>
        </div>

        {/* PIN Row */}
        <div className="edit-pin-row" style={{ marginTop: 16 }}>
          <div className="edit-pin-label">
            <span>🔐</span> Confirm PIN
          </div>
          <input
            className="edit-pin-input"
            type="password"
            inputMode="numeric"
            maxLength={4}
            placeholder="• • • •"
            value={pin}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 4);
              setPin(val);
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pin.length === 4) handleConfirm();
            }}
            disabled={saving}
          />
        </div>

        {/* Error */}
        {error && <div className="edit-error">{error}</div>}

        {/* Actions */}
        <div className="edit-actions">
          <button className="edit-cancel-btn" onClick={onCancel} type="button" disabled={saving}>
            Cancel
          </button>
          <button
            className={`edit-save-btn ${saving ? 'loading' : ''}`}
            style={{ background: 'linear-gradient(135deg, #b45309, #d97706)' }}
            onClick={handleConfirm}
            type="button"
            disabled={saving || pin.length !== 4}
          >
            {saving
              ? <><span className="spinner">⟳</span> Carrying Forward...</>
              : `📋 Carry Forward ${source === 'BOT' ? 'BOT/Bloomberg' : source}`}
          </button>
        </div>
      </div>
    </div>
  );
}
