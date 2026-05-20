'use client';

import { useState, useEffect, useRef } from 'react';

interface RateRow {
  id: number;
  source: string;
  currency: string;
  currency_label: string;
  rate_date: string;
  sell_tt: number | null;
  sell_notes: number | null;
  buy_tt: number | null;
  buy_sight: number | null;
  buy_transfer: number | null;
  buy_notes: number | null;
}

interface EditRateModalProps {
  isOpen: boolean;
  row: RateRow | null;
  onSuccess: () => void;
  onCancel: () => void;
}

function fmtField(val: number | null): string {
  if (val === null || val === undefined) return '';
  return val.toFixed(5);
}

export default function EditRateModal({ isOpen, row, onSuccess, onCancel }: EditRateModalProps) {
  const [fields, setFields] = useState({
    sell_tt: '',
    sell_notes: '',
    buy_tt: '',
    buy_sight: '',
    buy_transfer: '',
    buy_notes: '',
  });
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Reset form when row changes
  useEffect(() => {
    if (isOpen && row) {
      setFields({
        sell_tt: fmtField(row.sell_tt),
        sell_notes: fmtField(row.sell_notes),
        buy_tt: fmtField(row.buy_tt),
        buy_sight: fmtField(row.buy_sight),
        buy_transfer: fmtField(row.buy_transfer),
        buy_notes: fmtField(row.buy_notes),
      });
      setPin('');
      setError('');
      setSaving(false);
      setTimeout(() => firstInputRef.current?.focus(), 50);
    }
  }, [isOpen, row]);

  // Escape key closes
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onCancel]);

  async function handleSave() {
    if (!row) return;
    if (pin.length !== 4) {
      setError('Please enter your 4-digit PIN');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/edit-rate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          id: row.id,
          sell_tt: fields.sell_tt || null,
          sell_notes: fields.sell_notes || null,
          buy_tt: fields.buy_tt || null,
          buy_sight: fields.buy_sight || null,
          buy_transfer: fields.buy_transfer || null,
          buy_notes: fields.buy_notes || null,
        }),
      });
      const json = await res.json();
      if (json.success) {
        onSuccess();
      } else {
        setError(json.error || 'Save failed');
        setPin('');
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  if (!isOpen || !row) return null;

  const displaySource = row.source === 'BLOOMBERG' ? 'BOT' : row.source;

  return (
    <div className="edit-overlay" onClick={onCancel}>
      <div className="edit-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="edit-modal-header">
          <div className="edit-modal-title">
            <span className="edit-icon">✏️</span>
            <div>
              <div className="edit-title-main">Edit Rate</div>
              <div className="edit-title-sub">
                <span className={`bank-tag bank-${displaySource.toLowerCase()}`}>{displaySource}</span>
                {' '}
                <strong>{row.currency}</strong>
                {row.currency_label && <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>{row.currency_label}</span>}
                <span style={{ color: 'var(--text-faint)', marginLeft: 8, fontSize: 11 }}>{row.rate_date}</span>
              </div>
            </div>
          </div>
          <button className="edit-close-btn" onClick={onCancel} type="button">✕</button>
        </div>

        {/* Rate Fields */}
        <div className="edit-fields-grid">
          {([
            { key: 'sell_tt', label: 'Sell TT' },
            { key: 'sell_notes', label: 'Sell Notes' },
            { key: 'buy_tt', label: 'Buy TT' },
            { key: 'buy_sight', label: 'Buy Sight' },
            { key: 'buy_transfer', label: 'Buy Transfer' },
            { key: 'buy_notes', label: 'Buy Notes' },
          ] as const).map((field, i) => (
            <div className="edit-field-group" key={field.key}>
              <label className="edit-field-label">{field.label}</label>
              <input
                ref={i === 0 ? firstInputRef : undefined}
                className="edit-field-input"
                type="number"
                step="0.00001"
                min="0"
                placeholder="0.00000"
                value={fields[field.key]}
                onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                disabled={saving}
              />
            </div>
          ))}
        </div>

        {/* PIN Row */}
        <div className="edit-pin-row">
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
              if (e.key === 'Enter' && pin.length === 4) handleSave();
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
            onClick={handleSave}
            type="button"
            disabled={saving || pin.length !== 4}
          >
            {saving ? <><span className="spinner">⟳</span> Saving...</> : '✓ Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
