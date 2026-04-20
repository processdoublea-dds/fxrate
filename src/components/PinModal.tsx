'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

interface PinModalProps {
  isOpen: boolean;
  actionLabel: string;
  onSuccess: () => void;
  onCancel: () => void;
}

export default function PinModal({ isOpen, actionLabel, onSuccess, onCancel }: PinModalProps) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);
  const [success, setSuccess] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');

  // Use refs for callbacks to avoid stale closure issues
  const onSuccessRef = useRef(onSuccess);
  const onCancelRef = useRef(onCancel);
  const actionLabelRef = useRef(actionLabel);
  const hasVerifiedRef = useRef(false);

  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);
  useEffect(() => { onCancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => { actionLabelRef.current = actionLabel; }, [actionLabel]);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setPin('');
      setShake(false);
      setSuccess(false);
      setVerifying(false);
      setError('');
      hasVerifiedRef.current = false;
    }
  }, [isOpen]);

  const verifyPin = useCallback(async (fullPin: string) => {
    // Guard: don't verify if already verified or currently verifying
    if (hasVerifiedRef.current) return;

    setVerifying(true);
    setError('');
    hasVerifiedRef.current = true;

    try {
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: fullPin, actionLabel: actionLabelRef.current }),
      });
      const json = await res.json();

      if (json.valid) {
        setSuccess(true);
        setTimeout(() => {
          onSuccessRef.current();
        }, 400);
      } else {
        setShake(true);
        setError('Incorrect PIN');
        hasVerifiedRef.current = false; // Allow retry
        setTimeout(() => {
          setShake(false);
          setPin('');
          setError('');
        }, 800);
      }
    } catch {
      setShake(true);
      setError('Verification failed');
      hasVerifiedRef.current = false; // Allow retry
      setTimeout(() => {
        setShake(false);
        setPin('');
        setError('');
      }, 800);
    } finally {
      setVerifying(false);
    }
  }, []); // No dependencies — uses refs instead

  // Auto-verify when 4 digits entered
  useEffect(() => {
    if (pin.length === 4 && !hasVerifiedRef.current) {
      verifyPin(pin);
    }
  }, [pin, verifyPin]);

  // Keyboard support
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancelRef.current();
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setPin(prev => prev.slice(0, -1));
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        setPin(prev => {
          if (prev.length < 4 && !hasVerifiedRef.current) {
            return prev + e.key;
          }
          return prev;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handleKeyPress = (digit: string) => {
    if (pin.length < 4 && !verifying && !hasVerifiedRef.current) {
      setPin(prev => prev + digit);
    }
  };

  const handleBackspace = () => {
    setPin(prev => prev.slice(0, -1));
  };

  if (!isOpen) return null;

  return (
    <div className="pin-overlay" onClick={() => onCancelRef.current()}>
      <div
        className={`pin-modal ${shake ? 'pin-shake' : ''} ${success ? 'pin-success' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="pin-header">
          <div className="pin-lock-icon">🔐</div>
          <h3 className="pin-title">Confirm Action</h3>
          <p className="pin-action-label">{actionLabel}</p>
        </div>

        {/* PIN Dots */}
        <div className="pin-dots">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className={`pin-dot ${i < pin.length ? 'filled' : ''} ${success ? 'dot-success' : ''}`}
            />
          ))}
        </div>

        {/* Error message */}
        {error && <div className="pin-error">{error}</div>}

        {/* PIN Pad */}
        <div className="pin-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              className="pin-key"
              onClick={() => handleKeyPress(digit)}
              disabled={verifying || pin.length >= 4}
              type="button"
            >
              {digit}
            </button>
          ))}
          <button className="pin-key pin-key-empty" disabled type="button" />
          <button
            className="pin-key"
            onClick={() => handleKeyPress('0')}
            disabled={verifying || pin.length >= 4}
            type="button"
          >
            0
          </button>
          <button
            className="pin-key pin-key-backspace"
            onClick={handleBackspace}
            disabled={verifying || pin.length === 0}
            type="button"
          >
            ⌫
          </button>
        </div>

        {/* Cancel */}
        <button className="pin-cancel" onClick={() => onCancelRef.current()} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
