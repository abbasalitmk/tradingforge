'use client';

import React, { useEffect, useState } from 'react';

/** True on phone-width screens, where wide tables become stacked cards. */
export function useNarrow(maxWidth = 720): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [maxWidth]);
  return narrow;
}

export interface StrategyInfo {
  id: string;
  name: string;
  style: 'INTRADAY' | 'SWING';
  timeframe: '5m' | '1d';
  description: string;
}

export interface CategoryInfo {
  id: string;
  name: string;
  group: 'Broad' | 'Market cap' | 'Sector';
}

export interface Catalog {
  categories: CategoryInfo[];
  strategies: StrategyInfo[];
}

export type Side = 'BUY' | 'SELL';

/** A setup as the market routes return it (votes slimmed to their outcome). */
export interface SetupView {
  symbol: string;
  style: 'INTRADAY' | 'SWING';
  side: Side;
  entry: number;
  stopLoss: number;
  target: number;
  rewardRisk: number;
  quality: number;
  primaryStrategyId: string;
  agreeing: string[];
  conflicting: string[];
  reasons: string[];
  votes: Array<{ strategyId: string; name: string; style: string; side: Side | null; confidence: number }>;
  /** The live price is already through the stop or past the target: played out, not tradeable. */
  invalidReason?: string | null;
}

export const num = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
export const rupees = (n: number | null | undefined, d = 2): string => (n === null || n === undefined ? '—' : `₹${num(n, d)}`);
export const pct = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;

export const sideColor = (side: Side | null | undefined): string =>
  side === 'BUY' ? 'var(--ok)' : side === 'SELL' ? 'var(--danger)' : 'var(--muted)';
export const qualityColor = (q: number): string => (q >= 70 ? 'var(--ok)' : q >= 50 ? 'var(--warn)' : 'var(--muted)');

/** GET or POST JSON; errors come back as the route's own message. */
export async function api<T>(path: string, body?: unknown): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(path, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data) return { ok: true, data: data as T };
    const msg = typeof data?.['message'] === 'string' ? data['message'] : typeof data?.['error'] === 'string' ? data['error'] : `HTTP ${res.status}`;
    return { ok: false, error: msg, status: res.status };
  } catch (e) {
    return { ok: false, error: `Dashboard unreachable: ${e instanceof Error ? e.message : String(e)}`, status: 0 };
  }
}

export function Panel({ title, subtitle, right, children }: {
  title: string; subtitle?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        boxShadow: 'var(--card-shadow)',
        overflow: 'hidden',
        minWidth: 0,
      }}
    >
      <div
        style={{
          padding: '11px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 10,
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'var(--panel)',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--fg)', letterSpacing: '-0.01em' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      <div className="tf-panel-body" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
    </section>
  );
}

export function Chip({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={on}
      style={{
        fontSize: 11.5,
        fontWeight: on ? 600 : 500,
        padding: '5px 11px',
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        background: on ? 'var(--accent-subtle)' : 'var(--panel-subtle)',
        color: on ? 'var(--accent-fg)' : 'var(--muted)',
        transition: 'all 0.15s ease',
      }}
    >
      {children}
    </button>
  );
}

export function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: 999,
        border: `1px solid ${color}`,
        color: color,
        background: 'var(--panel-subtle)',
        whiteSpace: 'nowrap',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div
      style={{
        background: 'var(--panel-subtle)',
        border: '1px solid var(--line)',
        padding: '8px 12px',
        borderRadius: 8,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</div>
      <div
        className="tabular-nums"
        style={{
          fontSize: 13.5,
          fontWeight: 700,
          marginTop: 3,
          fontFamily: 'ui-monospace, monospace',
          color: color ?? 'var(--fg)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </div>
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  background: 'var(--panel-subtle)',
  border: '1px solid var(--line)',
  color: 'var(--fg)',
  borderRadius: 7,
  padding: '7px 10px',
  fontSize: 12.5,
  minWidth: 0,
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

export const buttonStyle: React.CSSProperties = {
  background: 'var(--accent)',
  border: 'none',
  color: '#ffffff',
  borderRadius: 7,
  padding: '8px 16px',
  fontSize: 12.5,
  fontWeight: 700,
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(37, 99, 235, 0.25)',
  transition: 'background-color 0.15s ease, transform 0.05s ease',
};

export function Note({ kind = 'muted', children }: { kind?: 'muted' | 'warn' | 'danger'; children: React.ReactNode }) {
  const color = kind === 'danger' ? 'var(--danger)' : kind === 'warn' ? 'var(--warn)' : 'var(--muted)';
  return <div style={{ fontSize: 11.5, color, lineHeight: 1.45 }}>{children}</div>;
}
