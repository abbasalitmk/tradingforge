'use client';

import React, { useCallback, useEffect, useState } from 'react';

export type TradingMode = 'PAPER' | 'LIVE';

const ARM_PHRASE = 'LIVE';
const POLL_MS = 3_000;

/**
 * The header's PAPER / LIVE switch. What it shows is ALWAYS the engine's own
 * effective mode, polled — never a browser-side memory of the last click. An
 * arm expires at the session end, a kill switch disarms, an engine restart
 * boots in PAPER, and another browser can arm: a remembered "LIVE" (or
 * "PAPER") would then be a lie about real money.
 */
export default function TradingModeToggle({
  onChange,
  compact = false,
}: {
  onChange?: (mode: TradingMode) => void;
  compact?: boolean;
}) {
  /** null = engine unreachable or not yet heard from. */
  const [mode, setMode] = useState<TradingMode | null>(null);
  const [engineMode, setEngineMode] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/proxy/health', { cache: 'no-store' });
      const data = (await res.json().catch(() => null)) as { mode?: string } | null;
      if (!res.ok || !data?.mode) throw new Error('offline');
      const next: TradingMode = data.mode === 'LIVE' ? 'LIVE' : 'PAPER';
      setEngineMode(data.mode);
      setMode((prev) => {
        if (prev !== next) onChange?.(next);
        return next;
      });
    } catch {
      setMode(null);
      setEngineMode(null);
    }
  }, [onChange]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    // Another control on the page changed the mode: confirm with the engine now.
    const handleSync = () => void refresh();
    window.addEventListener('tf:mode-change', handleSync);
    return () => {
      clearInterval(t);
      window.removeEventListener('tf:mode-change', handleSync);
    };
  }, [refresh]);

  const switchMode = async (target: TradingMode) => {
    if (target === mode || switching) return;

    let body: Record<string, string> = { mode: 'PAPER' };
    if (target === 'LIVE') {
      const typed = window.prompt(
        '⚠️ Enable LIVE TRADING with Real Money?\n\n' +
        '• New entries will be sent to your Upstox account.\n' +
        '• Open paper positions stay on paper.\n' +
        '• You must have completed "Login with Upstox" today.\n\n' +
        `Type ${ARM_PHRASE} to confirm`,
      );
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== ARM_PHRASE) {
        alert('LIVE not enabled: the confirmation phrase did not match.');
        return;
      }
      body = { mode: 'LIVE', confirmation: ARM_PHRASE };
    }

    setSwitching(true);
    try {
      const res = await fetch(target === 'LIVE' ? '/api/proxy/mode/arm' : '/api/proxy/mode/disarm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      if (!res.ok) throw new Error(data.error || `engine refused (HTTP ${res.status})`);
      if (data.detail) alert(data.detail);
      window.dispatchEvent(new CustomEvent('tf:mode-change', { detail: { mode: target } }));
    } catch (err) {
      alert(`⚠️ Could not switch to ${target}:\n\n${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await refresh();
      setSwitching(false);
    }
  };

  if (mode === null) {
    return (
      <div
        title="The trading engine is not reachable — its mode is unknown. Do not assume PAPER."
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          background: 'var(--panel-subtle)',
          border: '1px solid var(--warn)',
          fontSize: 11,
          color: 'var(--warn)',
          fontWeight: 700,
        }}
      >
        <span>ENGINE OFFLINE · MODE UNKNOWN</span>
      </div>
    );
  }

  const isLive = mode === 'LIVE';

  if (compact) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          background: 'var(--panel-subtle)',
          border: '1px solid var(--line)',
          borderRadius: 999,
          padding: 2,
        }}
      >
        <button
          type="button"
          onClick={() => switchMode('PAPER')}
          disabled={switching}
          title={`Engine mode: ${engineMode ?? 'unknown'} — switch to simulated Paper Mode`}
          style={{
            border: 'none',
            background: !isLive ? 'var(--ok-subtle)' : 'transparent',
            color: !isLive ? 'var(--ok)' : 'var(--muted)',
            fontWeight: 750,
            fontSize: 10.5,
            padding: '3px 9px',
            borderRadius: 999,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: !isLive ? 'var(--ok)' : 'var(--muted)' }} />
          <span>PAPER</span>
        </button>

        <button
          type="button"
          onClick={() => switchMode('LIVE')}
          disabled={switching}
          title={`Engine mode: ${engineMode ?? 'unknown'} — switch to LIVE Trading with Real Money (Upstox)`}
          style={{
            border: 'none',
            background: isLive ? 'var(--danger-subtle)' : 'transparent',
            color: isLive ? 'var(--danger)' : 'var(--muted)',
            fontWeight: 750,
            fontSize: 10.5,
            padding: '3px 9px',
            borderRadius: 999,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: isLive ? 'var(--danger)' : 'var(--muted)' }} />
          <span>LIVE</span>
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: 3,
        gap: 3,
        boxShadow: 'var(--card-shadow)',
      }}
    >
      <button
        type="button"
        onClick={() => switchMode('PAPER')}
        disabled={switching}
        style={{
          border: !isLive ? '1px solid var(--ok)' : '1px solid transparent',
          background: !isLive ? 'var(--ok-subtle)' : 'transparent',
          color: !isLive ? 'var(--ok)' : 'var(--muted)',
          fontWeight: 700,
          fontSize: 11.5,
          padding: '5px 12px',
          borderRadius: 6,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'all 0.15s ease',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: !isLive ? 'var(--ok)' : 'var(--muted)' }} />
        <span>📄 Paper Mode (Simulated)</span>
      </button>

      <button
        type="button"
        onClick={() => switchMode('LIVE')}
        disabled={switching}
        style={{
          border: isLive ? '1px solid var(--danger)' : '1px solid transparent',
          background: isLive ? 'var(--danger-subtle)' : 'transparent',
          color: isLive ? 'var(--danger)' : 'var(--muted)',
          fontWeight: 700,
          fontSize: 11.5,
          padding: '5px 12px',
          borderRadius: 6,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'all 0.15s ease',
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: isLive ? 'var(--danger)' : 'var(--muted)', boxShadow: isLive ? '0 0 6px var(--danger)' : 'none' }} />
        <span>🔴 Live Trading (Real Money)</span>
      </button>
    </div>
  );
}
