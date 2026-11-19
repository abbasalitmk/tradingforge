'use client';

import React from 'react';

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
    <section style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden', minWidth: 0 }}>
      <div
        style={{
          padding: '12px 16px', borderBottom: '1px solid var(--line)', display: 'flex', flexWrap: 'wrap',
          gap: 10, justifyContent: 'space-between', alignItems: 'center',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 14 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>{children}</div>
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
        fontSize: 11.5, padding: '4px 9px', borderRadius: 999, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        background: on ? 'rgba(74,158,255,0.15)' : 'transparent',
        color: on ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  );
}

export function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4, border: `1px solid ${color}`, color, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export function Stat({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', padding: '7px 9px', borderRadius: 6, minWidth: 0 }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, marginTop: 2, fontFamily: 'monospace', color: color ?? 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.04)', border: '1px solid var(--line)', color: 'var(--fg)',
  borderRadius: 6, padding: '6px 8px', fontSize: 12.5, minWidth: 0,
};

export const buttonStyle: React.CSSProperties = {
  background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: 6,
  padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
};

export function Note({ kind = 'muted', children }: { kind?: 'muted' | 'warn' | 'danger'; children: React.ReactNode }) {
  const color = kind === 'danger' ? 'var(--danger)' : kind === 'warn' ? 'var(--warn)' : 'var(--muted)';
  return <div style={{ fontSize: 11.5, color, lineHeight: 1.45 }}>{children}</div>;
}
