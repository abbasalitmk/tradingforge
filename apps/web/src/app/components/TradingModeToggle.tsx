'use client';

import React, { useEffect, useState } from 'react';

export type TradingMode = 'PAPER' | 'LIVE';

const STORAGE_KEY = 'tf_trading_mode';

export default function TradingModeToggle({
  onChange,
  compact = false,
}: {
  onChange?: (mode: TradingMode) => void;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<TradingMode>('PAPER');
  const [mounted, setMounted] = useState(false);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    setMounted(true);
    // 1. Read from localStorage
    const saved = localStorage.getItem(STORAGE_KEY) as TradingMode | null;
    if (saved === 'LIVE' || saved === 'PAPER') {
      setMode(saved);
      onChange?.(saved);
    } else {
      // 2. Fall back to /api/mode
      fetch('/api/mode')
        .then((r) => r.json())
        .then((data) => {
          if (data.mode === 'LIVE' || data.mode === 'PAPER') {
            setMode(data.mode);
            localStorage.setItem(STORAGE_KEY, data.mode);
            onChange?.(data.mode);
          }
        })
        .catch(() => undefined);
    }

    const handleSync = (e: Event) => {
      const custom = e as CustomEvent<{ mode: TradingMode }>;
      if (custom.detail?.mode) {
        setMode(custom.detail.mode);
      }
    };
    window.addEventListener('tf:mode-change', handleSync);
    return () => window.removeEventListener('tf:mode-change', handleSync);
  }, []);

  const switchMode = async (target: TradingMode) => {
    if (target === mode) return;

    if (target === 'LIVE') {
      const confirmed = window.confirm(
        '⚠️ Enable LIVE TRADING with Real Money?\n\n' +
        '• Real orders will be routed directly to your Upstox account.\n' +
        '• Ensure you have completed "Login with Upstox" for today\'s session.\n' +
        '• Fixed risk limits and stop losses will be enforced.\n\n' +
        'Click OK to switch to LIVE TRADING.'
      );
      if (!confirmed) return;
    }

    setSwitching(true);
    setMode(target);
    localStorage.setItem(STORAGE_KEY, target);
    onChange?.(target);
    window.dispatchEvent(new CustomEvent('tf:mode-change', { detail: { mode: target } }));

    try {
      // Persist to server cookie
      await fetch('/api/mode', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: target }),
      });

      // Also notify engine if reachable
      if (target === 'LIVE') {
        await fetch('/api/proxy/mode/arm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'LIVE' }),
        }).catch(() => undefined);
      } else {
        await fetch('/api/proxy/mode/disarm', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'PAPER' }),
        }).catch(() => undefined);
      }
    } catch {
      // Ignore network errors in offline/preview
    } finally {
      setSwitching(false);
    }
  };

  if (!mounted) {
    return (
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '2px 8px',
          borderRadius: 999,
          background: 'var(--panel-subtle)',
          border: '1px solid var(--line)',
          fontSize: 11,
          color: 'var(--muted)',
          fontWeight: 700,
        }}
      >
        <span>PAPER MODE</span>
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
          title="Switch to simulated Paper Mode (Risk-Free)"
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
          title="Switch to LIVE Trading with Real Money (Upstox)"
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
