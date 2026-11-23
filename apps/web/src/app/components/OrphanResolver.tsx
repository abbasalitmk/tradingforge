'use client';

import React, { useState } from 'react';
import { Note, inputStyle, buttonStyle, api } from './ui.tsx';

export interface OrphanTarget {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  filledQuantity: number;
  avgEntry: number | null;
  entry: number;
  broker?: 'PAPER' | 'UPSTOX';
  exitReason?: string | null;
}

/**
 * An ORPHANED position is one the engine cannot account for — it halts new
 * entries until a person checks the broker and says what is true. This is the
 * only way to clear it, and every resolution is audited with the note.
 */
export default function OrphanResolver({ position, onClose, onDone }: {
  position: OrphanTarget;
  onClose: () => void;
  onDone: (msg: string, kind?: 'ok' | 'error') => void;
}) {
  const [resolution, setResolution] = useState<'CLOSED' | 'MANAGING'>('CLOSED');
  const [exitPrice, setExitPrice] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const live = position.broker === 'UPSTOX';
  const filled = position.filledQuantity > 0 && position.avgEntry !== null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await api<{ detail: string }>('/api/proxy/positions/resolve', {
      positionId: position.id, resolution, note,
      ...(resolution === 'CLOSED' && exitPrice.trim() ? { exitPrice: Number(exitPrice) } : {}),
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onDone(`${position.symbol}: ${r.data.detail}`);
    onClose();
  };

  const option = (value: 'CLOSED' | 'MANAGING', title: string, detail: string, disabled = false) => (
    <label style={{
      display: 'flex', gap: 10, padding: '10px 12px', borderRadius: 8, cursor: disabled ? 'not-allowed' : 'pointer',
      border: `1px solid ${resolution === value ? 'var(--accent)' : 'var(--line)'}`, opacity: disabled ? 0.5 : 1,
      background: resolution === value ? 'var(--accent-subtle)' : 'var(--panel-subtle)',
    }}>
      <input type="radio" name="resolution" checked={resolution === value} disabled={disabled} onChange={() => setResolution(value)} />
      <span>
        <span style={{ fontWeight: 700, fontSize: 12.5 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{detail}</span>
      </span>
    </label>
  );

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="orphan-title" onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--panel)', border: '1px solid var(--danger)', borderRadius: 12, padding: 20, width: 'min(520px, 100%)', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div id="orphan-title" style={{ fontWeight: 800, fontSize: 15, color: 'var(--danger)' }}>
          Resolve orphaned position — {position.symbol}
        </div>
        <Note kind="warn">
          {position.side} {position.filledQuantity} @ ₹{(position.avgEntry ?? position.entry).toFixed(2)} on {live ? 'UPSTOX (real money)' : 'PAPER'}.
          {position.exitReason ? ` Reason: ${position.exitReason}` : ''}
        </Note>
        <Note>
          {live
            ? 'Check the Upstox app first: Positions, Orders and GTT list. Record only what you see there.'
            : 'Paper position: choose what should happen to it in the simulation.'}
        </Note>

        {option('CLOSED', 'No longer held', 'It was exited or never filled. Enter the exit price to book its P&L (leave blank if unknown).')}
        {resolution === 'CLOSED' && (
          <input type="number" min={0} step={0.05} value={exitPrice} onChange={(e) => setExitPrice(e.target.value)}
            placeholder="Exit price in ₹ (optional)" style={inputStyle} />
        )}
        {option('MANAGING', 'Still held, bracket is live', 'The position and its stop/target GTT exist at the broker — the engine resumes managing it.', !filled)}

        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
          placeholder="What you verified, e.g. “GTT 2511… shows SL triggered, sold 10 @ 2841.5”" style={{ ...inputStyle, resize: 'vertical' }} />

        {error && <Note kind="danger">{error}</Note>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose} style={{ ...buttonStyle, background: 'var(--panel-subtle)', color: 'var(--fg)', border: '1px solid var(--line)', boxShadow: 'none' }}>Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={busy || note.trim().length < 3}
            style={{ ...buttonStyle, background: 'var(--danger)', opacity: busy || note.trim().length < 3 ? 0.5 : 1 }}>
            {busy ? 'Resolving…' : 'Confirm resolution'}
          </button>
        </div>
      </div>
    </div>
  );
}
