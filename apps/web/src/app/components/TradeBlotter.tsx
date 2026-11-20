'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Panel, Pill, Stat, Note, api, rupees, num, sideColor, qualityColor, type Side } from './ui.tsx';

/** One engine position as GET /state returns it. */
export interface BlotterPosition {
  id: string;
  symbol: string;
  side: Side;
  state: string;
  quantity: number;
  filledQuantity: number;
  entry: number;
  avgEntry: number | null;
  stopLoss: number;
  target: number;
  ltp: number;
  pnlRupees: number;
  openedAt: number;
  filledAt?: number | null;
  closedAt?: number | null;
  exitPrice?: number | null;
  exitReason?: string | null;
  product?: string;
  broker?: 'PAPER' | 'UPSTOX';
  style?: 'INTRADAY' | 'SWING';
  strategyId?: string | null;
  quality?: number | null;
  capitalRupees?: number;
  contract?: { tradingSymbol: string };
}

/** A closed trade from the persistent trade log (GET /memory/trades). */
interface TradeLogEntry {
  positionId: string;
  strategyId: string | null;
  mode: string;
  segment: 'EQ' | 'FO';
  style: string;
  symbol: string;
  side: Side;
  quantity: number;
  entryTime: number | null;
  entryPrice: number | null;
  plannedEntry: number;
  stopLoss: number;
  target: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  slippage: number | null;
  charges: number;
  grossPnl: number;
  netPnl: number;
  rMultiple: number | null;
  quality: number | null;
}

const OPEN_STATES = new Set(['ENTRY_SENT', 'ENTRY_ACKED', 'ENTRY_FILLED', 'BRACKET_ARMED', 'MANAGING', 'EXIT_TRIGGERED', 'ORPHANED']);
const STATE_LABEL: Record<string, string> = {
  ENTRY_SENT: 'Order sent', ENTRY_ACKED: 'Awaiting fill', ENTRY_FILLED: 'Filled', BRACKET_ARMED: 'Bracket armed',
  MANAGING: 'Open · bracket live', EXIT_TRIGGERED: 'Exiting', ORPHANED: 'ORPHANED — resolve',
};

const istTime = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '—';
const istDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const held = (from: number | null | undefined, to: number): string => {
  if (!from) return '—';
  const m = Math.max(0, Math.round((to - from) / 60_000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
const signed = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : ''}${rupees(n)}`);
const pnlColor = (n: number | null | undefined): string => (!n ? 'var(--muted)' : n > 0 ? 'var(--ok)' : 'var(--danger)');
/** Distance from the live price to a level, as % of price, in the direction a move must go to reach it. */
const away = (ltp: number, level: number): string => (ltp > 0 ? `${(Math.abs(level - ltp) / ltp * 100).toFixed(2)}%` : '—');

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, verticalAlign: 'top', whiteSpace: 'nowrap' };
const sub: React.CSSProperties = { fontSize: 10.5, color: 'var(--muted)', marginTop: 2 };

/**
 * What the engine bought or sold, and how each trade is doing: every open
 * position live, and every trade closed today from the persistent trade log
 * (so it survives engine restarts), with charges and net P&L.
 */
export default function TradeBlotter({ positions, realisedToday, unrealised, now, onExit, onResolve }: {
  positions: BlotterPosition[];
  realisedToday: number;
  unrealised: number;
  now: number;
  onExit: (positionId: string) => void;
  onResolve: (p: BlotterPosition) => void;
}) {
  const [trades, setTrades] = useState<TradeLogEntry[] | null>(null);
  const [tradesError, setTradesError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ trades: TradeLogEntry[] }>('/api/proxy/memory/trades?limit=200');
    if (!r.ok) { setTradesError(r.error); return; }
    setTradesError(null);
    setTrades(r.data.trades);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const open = positions.filter((p) => OPEN_STATES.has(p.state)).sort((a, b) => b.openedAt - a.openedAt);
  const today = istDay(now);
  const closedToday = (trades ?? []).filter((t) => t.exitTime !== null && istDay(t.exitTime) === today);
  const wins = closedToday.filter((t) => t.netPnl > 0).length;
  const netToday = closedToday.reduce((a, t) => a + t.netPnl, 0);
  const chargesToday = closedToday.reduce((a, t) => a + t.charges, 0);
  const deployed = open.reduce((a, p) => a + (p.capitalRupees ?? 0), 0);
  // Rejected/cancelled entries never reach the trade log; show today's so a failed order is visible too.
  const failedToday = positions.filter((p) => (p.state === 'REJECTED' || p.state === 'CANCELLED') && istDay(p.openedAt) === today);

  return (
    <Panel
      title="Trade blotter"
      subtitle="Which stocks the engine bought or sold, live P&L on open positions, and every trade closed today (net of charges)."
      right={<Pill color={open.length ? 'var(--accent)' : 'var(--muted)'}>{open.length} open · {closedToday.length} closed today</Pill>}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <Stat label="Open positions" value={open.length} />
        <Stat label="Capital deployed" value={rupees(deployed, 0)} />
        <Stat label="Unrealised P&L" value={signed(unrealised)} color={pnlColor(unrealised)} />
        <Stat label="Realised today (gross)" value={signed(realisedToday)} color={pnlColor(realisedToday)} />
        <Stat label="Net today (after charges)" value={trades ? signed(netToday) : '—'} color={pnlColor(netToday)} />
        <Stat label="Win rate today" value={closedToday.length ? `${Math.round((wins / closedToday.length) * 100)}% (${wins}/${closedToday.length})` : '—'} />
      </div>

      <div style={{ fontSize: 12.5, fontWeight: 700 }}>Open positions</div>
      {open.length === 0 ? (
        <Note>No open positions. When autonomous mode enters a trade it appears here within two seconds.</Note>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--line)' }}>
              {['Stock', 'Position', 'Entry → LTP', 'P&L', 'Stop / Target', 'Strategy', 'Opened', 'Status', ''].map((h) => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {open.map((p) => {
                const entry = p.avgEntry ?? p.entry;
                const pct = entry > 0 && p.filledQuantity > 0 ? (p.pnlRupees / (entry * p.filledQuantity)) * 100 : null;
                return (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--line)' }}>
                    <td style={td}>
                      <strong>{p.contract?.tradingSymbol ?? p.symbol}</strong>{' '}
                      <span style={{ fontSize: 10, fontWeight: 700, color: p.broker === 'UPSTOX' ? 'var(--danger)' : 'var(--muted)' }}>{p.broker === 'UPSTOX' ? 'LIVE' : 'PAPER'}</span>
                      <div style={sub}>{p.style === 'SWING' ? 'Swing · delivery' : 'Intraday · MIS'}{p.product ? ` (${p.product})` : ''}</div>
                    </td>
                    <td style={td}>
                      <span style={{ color: sideColor(p.side), fontWeight: 700 }}>{p.side === 'BUY' ? 'BOUGHT' : 'SOLD SHORT'}</span>
                      <div style={sub}>{p.filledQuantity}/{p.quantity} qty · {rupees(p.capitalRupees ?? entry * p.quantity, 0)}</div>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>
                      {rupees(entry)} → {rupees(p.ltp)}
                      {p.avgEntry !== null && Math.abs(p.avgEntry - p.entry) >= 0.01 && <div style={sub}>planned {rupees(p.entry)}</div>}
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: pnlColor(p.pnlRupees) }}>
                      {signed(p.pnlRupees)}
                      <div style={{ ...sub, color: pnlColor(p.pnlRupees) }}>{pct === null ? '' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`}</div>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>
                      <span style={{ color: 'var(--danger)' }}>{rupees(p.stopLoss)}</span> / <span style={{ color: 'var(--ok)' }}>{rupees(p.target)}</span>
                      <div style={sub}>{away(p.ltp, p.stopLoss)} to stop · {away(p.ltp, p.target)} to target</div>
                    </td>
                    <td style={td}>
                      {p.strategyId ?? '—'}
                      {p.quality !== null && p.quality !== undefined && <div style={{ ...sub, color: qualityColor(p.quality) }}>quality {p.quality}</div>}
                    </td>
                    <td style={td}>{istTime(p.openedAt)}<div style={sub}>held {held(p.filledAt ?? p.openedAt, now)}</div></td>
                    <td style={{ ...td, color: p.state === 'ORPHANED' ? 'var(--danger)' : undefined, fontWeight: p.state === 'ORPHANED' ? 700 : 400 }}>
                      {STATE_LABEL[p.state] ?? p.state}
                      {p.exitReason && <div style={{ ...sub, whiteSpace: 'normal', maxWidth: 220 }}>{p.exitReason}</div>}
                    </td>
                    <td style={td}>
                      {p.state === 'ORPHANED'
                        ? <button type="button" onClick={() => onResolve(p)} style={smallBtn('var(--danger)', true)}>Resolve</button>
                        : (p.state === 'MANAGING' || p.state === 'ENTRY_ACKED') && (
                          <button type="button" onClick={() => onExit(p.id)} style={smallBtn('var(--danger)', false)}>{p.state === 'ENTRY_ACKED' ? 'Cancel' : 'Exit'}</button>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ fontSize: 12.5, fontWeight: 700 }}>Closed today {chargesToday > 0 && <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: 11 }}>· charges {rupees(chargesToday)}</span>}</div>
      {tradesError && <Note kind="danger">Trade log unavailable: {tradesError}</Note>}
      {!tradesError && closedToday.length === 0 && <Note>No trades closed today yet.</Note>}
      {closedToday.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
            <thead><tr style={{ borderBottom: '1px solid var(--line)' }}>
              {['In → Out', 'Stock', 'Trade', 'Entry → Exit', 'Gross', 'Charges', 'Net', 'R', 'Exit reason', 'Strategy'].map((h) => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {closedToday.map((t) => (
                <tr key={t.positionId} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={td}>{istTime(t.entryTime)} → {istTime(t.exitTime)}<div style={sub}>held {held(t.entryTime, t.exitTime ?? now)}</div></td>
                  <td style={td}><strong>{t.symbol}</strong> <span style={{ fontSize: 10, fontWeight: 700, color: t.mode === 'LIVE' ? 'var(--danger)' : 'var(--muted)' }}>{t.mode === 'LIVE' ? 'LIVE' : 'PAPER'}</span><div style={sub}>{t.style === 'SWING' ? 'Swing' : 'Intraday'} · {t.segment}</div></td>
                  <td style={td}><span style={{ color: sideColor(t.side), fontWeight: 700 }}>{t.side}</span> × {t.quantity}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>
                    {rupees(t.entryPrice)} → {rupees(t.exitPrice)}
                    <div style={sub}>SL {rupees(t.stopLoss)} · T {rupees(t.target)}</div>
                  </td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: pnlColor(t.grossPnl) }}>{signed(t.grossPnl)}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', color: 'var(--muted)' }}>{rupees(t.charges)}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace', fontWeight: 700, color: pnlColor(t.netPnl) }}>{signed(t.netPnl)}</td>
                  <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{t.rMultiple === null ? '—' : `${t.rMultiple >= 0 ? '+' : ''}${num(t.rMultiple)}R`}</td>
                  <td style={{ ...td, whiteSpace: 'normal', maxWidth: 200 }}>{t.exitReason ?? '—'}</td>
                  <td style={td}>{t.strategyId ?? '—'}{t.quality !== null && <div style={{ ...sub, color: qualityColor(t.quality) }}>quality {t.quality}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {failedToday.length > 0 && (
        <Note kind="warn">
          {failedToday.length} order(s) did not fill today: {failedToday.slice(0, 6).map((p) => `${p.symbol} (${p.exitReason ?? p.state.toLowerCase()})`).join(' · ')}
        </Note>
      )}
    </Panel>
  );
}

const smallBtn = (color: string, solid: boolean): React.CSSProperties => ({
  background: solid ? color : 'transparent', color: solid ? '#ffffff' : color, border: `1px solid ${color}`,
  borderRadius: 4, padding: '3px 9px', fontSize: 10.5, fontWeight: 700, cursor: 'pointer',
});
