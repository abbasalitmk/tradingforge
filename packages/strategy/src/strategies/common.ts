import {
  type Candle, type Side, type Signal, type TradingStyle, type Paise,
  istDateKey, istMinutes, SESSION, rupeesToPaise, newSignalId,
} from '@tradeforger/core';
import type { StrategyContext } from '../profile.ts';
import { type Confluence, passedNames } from '../profile.ts';

/*
 * Plumbing shared by the catalog strategies. Everything here is pure: the
 * only notion of "now" is the clock carried in the context.
 */

/**
 * Bars that had already started before `nowMs`.
 *
 * A caller that hands a strategy the whole day while asking "what would you
 * have done at 11:00?" would otherwise leak the afternoon into the decision.
 * The comparison is strict because in a backtest the clock sits on a bar's
 * close, which is exactly the next bar's open timestamp — that next bar has
 * not happened yet. Scanning from the end keeps the common case (nothing in
 * the future) allocation-free.
 */
export function visibleCandles(candles: readonly Candle[], nowMs: number): readonly Candle[] {
  let end = candles.length;
  while (end > 0 && candles[end - 1]!.ts >= nowMs) end--;
  return end === candles.length ? candles : candles.slice(0, end);
}

/** Inside the window in which new intraday entries are allowed. */
export function inEntryWindow(now: Date): boolean {
  const m = istMinutes(now);
  return m >= SESSION.ENTRY_START && m < SESSION.ENTRY_END;
}

/**
 * Index of the first bar of the LAST bar's IST session.
 *
 * Intraday callers pass several prior sessions for indicator warmup, so any
 * session-anchored level (VWAP, day high/low, opening range) must be computed
 * from this index onwards — yesterday's VWAP is a different reference price.
 */
export function sessionStartIndex(candles: readonly Candle[]): number {
  const last = candles[candles.length - 1];
  if (!last) return 0;
  const key = istDateKey(new Date(last.ts));
  let i = candles.length - 1;
  while (i > 0 && istDateKey(new Date(candles[i - 1]!.ts)) === key) i--;
  return i;
}

/**
 * Cumulative VWAP over one session's bars, aligned index-for-index.
 *
 * Computed here rather than via the indicators package's `vwap`, which resets
 * on the UTC date: identical for the NSE cash session, but anchoring on the
 * IST session explicitly removes any doubt about which day's volume counts.
 */
export function sessionVwap(session: readonly Candle[]): number[] {
  const out: number[] = [];
  let pv = 0, vol = 0;
  for (const c of session) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    vol += c.volume;
    out.push(vol === 0 ? typical : pv / vol);
  }
  return out;
}

/** Share of `values` strictly below `x`, as 0-100. */
export function percentileRank(values: readonly number[], x: number): number {
  if (values.length === 0) return 50;
  const below = values.filter((v) => v < x).length;
  return (below / values.length) * 100;
}

export interface IntradayFrame {
  /** Candles visible at evaluation time (prior sessions included). */
  readonly candles: readonly Candle[];
  /** Index into `candles` where today's session starts. */
  readonly sessionStart: number;
  /** Today's bars only. */
  readonly session: readonly Candle[];
  readonly last: Candle;
}

/**
 * Common preconditions for an intraday evaluation: inside the entry window,
 * enough bars, and data that is actually from today. A feed that stalled
 * overnight would otherwise let yesterday's 15:25 bar trigger a morning entry.
 */
export function intradayFrame(ctx: StrategyContext, warmupBars: number): IntradayFrame | null {
  const now = ctx.clock.now();
  if (!inEntryWindow(now)) return null;
  const candles = visibleCandles(ctx.candles, now.getTime());
  if (candles.length < warmupBars) return null;
  const last = candles[candles.length - 1]!;
  if (istDateKey(new Date(last.ts)) !== istDateKey(now)) return null;
  const sessionStart = sessionStartIndex(candles);
  return { candles, sessionStart, session: candles.slice(sessionStart), last };
}

/** Clamp a structural stop distance into a sane ATR band. */
export function clampStop(raw: number, atr: number, minAtr: number, maxAtr: number): number {
  return Math.min(maxAtr * atr, Math.max(minAtr * atr, raw));
}

export interface Geometry {
  readonly entry: Paise;
  readonly stopLoss: Paise;
  readonly target: Paise;
}

/**
 * Entry/stop/target in paise, or null if the geometry is degenerate.
 *
 * A stop that rounds onto the entry is a zero-risk denominator for sizing —
 * infinite quantity — so it is refused outright rather than nudged.
 */
export function riskGeometry(
  side: Side,
  price: number,
  stopDistance: number,
  targetDistance: number,
): Geometry | null {
  if (!Number.isFinite(stopDistance) || !Number.isFinite(targetDistance)) return null;
  if (stopDistance <= 0 || targetDistance <= 0 || price <= 0) return null;
  const long = side === 'BUY';
  const entry = rupeesToPaise(price);
  const stopLoss = rupeesToPaise(long ? price - stopDistance : price + stopDistance);
  const target = rupeesToPaise(long ? price + targetDistance : price - targetDistance);
  if (stopLoss === entry || target === entry) return null;
  if (stopLoss <= 0 || target <= 0) return null;
  return { entry, stopLoss, target };
}

export function buildSignal(args: {
  readonly ctx: StrategyContext;
  readonly style: TradingStyle;
  readonly side: Side;
  readonly geometry: Geometry;
  readonly atr: number;
  readonly confidence: number;
  readonly checks: readonly Confluence[];
  readonly indicators: Readonly<Record<string, number>>;
}): Signal {
  const { ctx, geometry } = args;
  return {
    id: newSignalId(),
    instrumentKey: ctx.instrumentKey,
    symbol: ctx.symbol,
    style: args.style,
    side: args.side,
    entry: geometry.entry,
    stopLoss: geometry.stopLoss,
    target: geometry.target,
    atr: args.atr,
    confidence: args.confidence,
    reasons: passedNames(args.checks),
    indicators: args.indicators,
    generatedAt: ctx.clock.ms(),
  };
}

/** Fraction of the bar's range covered by the wick against `side`. */
export function rejectionWick(c: Candle, side: Side): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return side === 'BUY'
    ? (Math.min(c.open, c.close) - c.low) / range
    : (c.high - Math.max(c.open, c.close)) / range;
}

/** Where the close sits in the bar's range, measured from the adverse end (0-1). */
export function closeLocation(c: Candle, side: Side): number {
  const range = c.high - c.low;
  if (range <= 0) return 0.5;
  return side === 'BUY' ? (c.close - c.low) / range : (c.high - c.close) / range;
}

export const fmt = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? 'n/a' : n.toFixed(d);
