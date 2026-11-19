import type { TradeRecord } from './engine.ts';

export interface Metrics {
  trades: number;
  /** Fraction of trades with netPnl > 0, 0..1. */
  winRate: number;
  /** Gross winning net-P&L / |gross losing net-P&L|. Capped at PF_CAP when
   *  there are no losses (kept finite so reports survive JSON). */
  profitFactor: number;
  /** Mean R multiple per trade, after costs. THE number that matters. */
  expectancyR: number;
  /** Mean net rupees per trade. */
  expectancyRs: number;
  netPnl: number;
  grossPnl: number;
  totalCosts: number;
  /** Largest peak-to-trough fall of closed-trade equity, % of the peak (≥ 0). */
  maxDrawdownPct: number;
  /** Annualised (√252) Sharpe of daily P&L / capital, weekdays with no
   *  exits counted as 0. 0 when undefined. */
  sharpe: number;
  /** Most consecutive non-winning trades (netPnl ≤ 0), in exit order. */
  longestLosingStreak: number;
  /** Mean R of winning trades (≥ 0). */
  avgWinR: number;
  /** Mean R of non-winning trades (≤ 0). */
  avgLossR: number;
  /** netPnl as % of starting capital. */
  returnPct: number;
}

export const PF_CAP = 999;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const istDay = (ts: number): number => Math.floor((ts + IST_OFFSET_MS) / DAY_MS);

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Exit order — the order in which P&L is actually realised. */
function byExit(trades: readonly TradeRecord[]): TradeRecord[] {
  return [...trades].sort((a, b) => a.exitTs - b.exitTs || a.entryTs - b.entryTs);
}

/** Closed-trade equity, starting at `capital` just before the first entry. */
export function equityCurve(
  trades: readonly TradeRecord[],
  capital: number,
): Array<{ ts: number; equity: number }> {
  if (trades.length === 0) return [];
  const sorted = byExit(trades);
  const firstEntry = Math.min(...trades.map((t) => t.entryTs));
  const out: Array<{ ts: number; equity: number }> = [{ ts: firstEntry, equity: capital }];
  let eq = capital;
  for (const t of sorted) {
    eq += t.netPnl;
    out.push({ ts: t.exitTs, equity: eq });
  }
  return out;
}

function maxDrawdownPct(curve: ReadonlyArray<{ equity: number }>): number {
  let peak = -Infinity;
  let worst = 0;
  for (const { equity } of curve) {
    if (equity > peak) peak = equity;
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst * 100;
}

function dailySharpe(sorted: readonly TradeRecord[], capital: number): number {
  if (sorted.length === 0 || capital <= 0) return 0;
  const pnlByDay = new Map<number, number>();
  for (const t of sorted) {
    const d = istDay(t.exitTs);
    pnlByDay.set(d, (pnlByDay.get(d) ?? 0) + t.netPnl);
  }
  const first = istDay(sorted[0]!.exitTs);
  const last = istDay(sorted[sorted.length - 1]!.exitTs);
  const returns: number[] = [];
  for (let d = first; d <= last; d++) {
    // Day 0 of the epoch was a Thursday; weekday index 0=Mon..6=Sun.
    const weekday = (d + 3) % 7;
    const pnl = pnlByDay.get(d);
    if (weekday >= 5 && pnl === undefined) continue;
    returns.push((pnl ?? 0) / capital);
  }
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const variance = returns.reduce((a, r) => a + (r - m) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
}

export function computeMetrics(trades: readonly TradeRecord[], capital: number): Metrics {
  const n = trades.length;
  if (n === 0) {
    return {
      trades: 0, winRate: 0, profitFactor: 0, expectancyR: 0, expectancyRs: 0,
      netPnl: 0, grossPnl: 0, totalCosts: 0, maxDrawdownPct: 0, sharpe: 0,
      longestLosingStreak: 0, avgWinR: 0, avgLossR: 0, returnPct: 0,
    };
  }
  const sorted = byExit(trades);
  const wins = sorted.filter((t) => t.netPnl > 0);
  const losses = sorted.filter((t) => t.netPnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
  const grossLoss = -losses.reduce((a, t) => a + t.netPnl, 0);
  const profitFactor = grossLoss > 0
    ? Math.min(PF_CAP, grossWin / grossLoss)
    : grossWin > 0 ? PF_CAP : 0;

  let streak = 0;
  let longest = 0;
  for (const t of sorted) {
    streak = t.netPnl <= 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }

  const netPnl = sorted.reduce((a, t) => a + t.netPnl, 0);
  return {
    trades: n,
    winRate: wins.length / n,
    profitFactor,
    expectancyR: mean(sorted.map((t) => t.rMultiple)),
    expectancyRs: netPnl / n,
    netPnl,
    grossPnl: sorted.reduce((a, t) => a + t.grossPnl, 0),
    totalCosts: sorted.reduce((a, t) => a + t.costs, 0),
    maxDrawdownPct: maxDrawdownPct(equityCurve(sorted, capital)),
    sharpe: dailySharpe(sorted, capital),
    longestLosingStreak: longest,
    avgWinR: mean(wins.map((t) => t.rMultiple)),
    avgLossR: mean(losses.map((t) => t.rMultiple)),
    returnPct: capital > 0 ? (netPnl / capital) * 100 : 0,
  };
}
