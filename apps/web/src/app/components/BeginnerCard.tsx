'use client';

import React, { useState, useEffect } from 'react';

export default function BeginnerCard() {
  const [open, setOpen] = useState(true);
  const [activeTopic, setActiveTopic] = useState<'flow' | 'terms' | 'safety'>('flow');

  useEffect(() => {
    try {
      const stored = localStorage.getItem('tf-beginner-guide');
      if (stored === 'closed') setOpen(false);
    } catch {}
  }, []);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem('tf-beginner-guide', next ? 'open' : 'closed');
    } catch {}
  };

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, var(--accent-subtle) 0%, var(--panel) 100%)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: 'var(--card-shadow)',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 18px',
          borderBottom: open ? '1px solid var(--line)' : 'none',
          background: 'var(--panel)',
          cursor: 'pointer',
        }}
        onClick={toggle}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 18 }}>🎓</span>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--fg)' }}>
              Beginner's Trading Manual & Platform Guide
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              New to algorithmic & breakout trading? Learn how TradeForger works in 60 seconds
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-expanded={open}
          style={{
            background: 'var(--panel-subtle)',
            border: '1px solid var(--line)',
            color: 'var(--muted)',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {open ? 'Hide Guide ▲' : 'Show Beginner Guide ▼'}
        </button>
      </div>

      {open && (
        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Topic Selector Tabs */}
          <div style={{ display: 'flex', gap: 8 }}>
            {[
              { id: 'flow' as const, label: '1. How It Works (3 Steps)' },
              { id: 'terms' as const, label: '2. Key Trading Jargon Explained' },
              { id: 'safety' as const, label: '3. Safety & Circuit Breakers' },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTopic(t.id)}
                style={{
                  fontSize: 11.5,
                  fontWeight: activeTopic === t.id ? 700 : 500,
                  padding: '5px 12px',
                  borderRadius: 999,
                  border: `1px solid ${activeTopic === t.id ? 'var(--accent)' : 'var(--line)'}`,
                  background: activeTopic === t.id ? 'var(--accent)' : 'var(--panel-subtle)',
                  color: activeTopic === t.id ? '#ffffff' : 'var(--muted)',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Topic 1: How it Works */}
          {activeTopic === 'flow' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 }}>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--accent)', marginBottom: 4 }}>
                  STEP 1: Autonomous Scanning
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-secondary)', lineHeight: 1.45 }}>
                  The engine scans liquid NSE stocks every few seconds, looking for <strong>volume spikes (RVOL)</strong> and <strong>15-minute range breakouts (ORB)</strong>.
                </div>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--ok)', marginBottom: 4 }}>
                  STEP 2: 3-Model AI Consensus
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-secondary)', lineHeight: 1.45 }}>
                  Before entering, 3 AI models (Quant geometry, Pattern analysis, and ML expectancy) vote. If they agree (Grade A/A+), the signal is approved.
                </div>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--warn)', marginBottom: 4 }}>
                  STEP 3: Automatic Exit Brackets
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-secondary)', lineHeight: 1.45 }}>
                  Every trade enters with a predefined <strong>Stop-Loss</strong> and <strong>Target (1:1.5 to 1:2.5)</strong> via Upstox GTT OCO orders. No emotional manual exits!
                </div>
              </div>
            </div>
          )}

          {/* Topic 2: Terms */}
          {activeTopic === 'terms' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--fg)' }}>LTP (Last Traded Price)</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  The most recent price at which a stock was bought or sold on the NSE exchange right now.
                </p>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--ok)' }}>ORB (Opening Range Breakout)</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  The high/low price of the first 15 minutes of trading. Crossing above means strong buyers are active.
                </p>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--accent)' }}>RVOL (Relative Volume)</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  How today's volume compares to normal. 2.0x means twice the normal institutional volume is surging.
                </p>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--danger)' }}>Stop Loss (SL)</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  The safety price where the trade exits automatically to cap your maximum possible loss.
                </p>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--ok)' }}>Target (Take Profit)</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  The price goal where your profits are locked in automatically (usually 1.5x to 2.5x your risk).
                </p>
              </div>
              <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 10 }}>
                <strong style={{ fontSize: 11.5, color: 'var(--warn)' }}>VWAP & SuperTrend</strong>
                <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.4 }}>
                  Key technical gauges. Above VWAP + Green SuperTrend = High probability bullish continuation.
                </p>
              </div>
            </div>
          )}

          {/* Topic 3: Safety */}
          {activeTopic === 'safety' && (
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--danger)', marginBottom: 4 }}>
                🛡️ Built-in Risk Guard & SEBI Compliance
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-secondary)', lineHeight: 1.5 }}>
                TradeForger operates under strict mathematical risk controls:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  <li><strong>Paper Trading Mode:</strong> Safe default sandbox mode using simulated capital with zero real money at risk.</li>
                  <li><strong>Daily Max Loss Circuit Breaker:</strong> If losses hit the daily limit, all auto-trading immediately shuts down for the day.</li>
                  <li><strong>Single-Click Emergency Kill Switch:</strong> One click closes all open positions and cancels outstanding orders immediately.</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
