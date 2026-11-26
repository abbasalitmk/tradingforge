import { type Candle, type Side, type Signal, paiseToRupees, rupeesToPaise } from '@tradeforger/core';
import { atr, latest } from '@tradeforger/indicators';
import { sessionStartIndex, priorSession, dayLevels } from './strategies/common.ts';

/*
 * Where stop-loss orders cluster. Retail stops sit just beyond the obvious
 * levels — yesterday's high and low, the opening range, a run of equal highs
 * or lows, a round number — and a larger player who needs size fills it by
 * driving price through them ("sweeping the liquidity") before the real move.
 * These helpers find those levels, so an entry can trade the sweep and a stop
 * can be kept out of it.
 */

export type LiquidityKind = 'PDH' | 'PDL' | 'ORH' | 'ORL' | 'EQH' | 'EQL' | 'ROUND';

export interface LiquidityLevel {
  readonly kind: LiquidityKind;
  readonly price: number;
  /** HIGH: buy stops (shorts' stops, breakout buys) rest above it. LOW: sell stops rest below it. */
  readonly side: 'HIGH' | 'LOW';
}

export interface LevelOptions {
  /** The opening range, in 5-minute bars. */
  readonly openingBars?: number;
  /** Bars either side a swing high/low must dominate. */
  readonly swingLength?: number;
  /** Swings within this many ATRs of each other are "equal". */
  readonly equalTolAtr?: number;
  readonly withRound?: boolean;
}

/** Spacing of the round numbers traders anchor to, by price. */
export function roundStep(price: number): number {
  if (price < 50) return 1;
  if (price < 200) return 5;
  if (price < 1000) return 10;
  if (price < 5000) return 50;
  return 100;
}

/** Swing extremes confirmed by `len` bars either side, from `from` onwards. */
function swings(bars: readonly Candle[], len: number, from: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = Math.max(from, len); i < bars.length - len; i++) {
    const b = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= len; k++) {
      if (bars[i - k]!.high >= b.high || bars[i + k]!.high > b.high) isHigh = false;
      if (bars[i - k]!.low <= b.low || bars[i + k]!.low < b.low) isLow = false;
    }
    if (isHigh) highs.push(b.high);
    if (isLow) lows.push(b.low);
  }
  return { highs, lows };
}

/** Prices that two or more swings share within `tol`: the outermost of each group (where the stops are). */
function equalLevels(prices: readonly number[], tol: number, side: 'HIGH' | 'LOW'): number[] {
  const sorted = [...prices].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  const flush = (): void => {
    if (group.length >= 2) out.push(side === 'HIGH' ? Math.max(...group) : Math.min(...group));
    group = [];
  };
  for (const p of sorted) {
    if (group.length > 0 && p - group[0]! > tol) flush();
    group.push(p);
  }
  flush();
  return out;
}

/**
 * Liquidity levels visible at the last bar of `candles` (closed 5-minute
 * bars, prior sessions included for yesterday's levels). Today's swings
 * count only once confirmed, so nothing here depends on the bar being judged.
 */
export function liquidityLevels(candles: readonly Candle[], atr: number, o: LevelOptions = {}): LiquidityLevel[] {
  const last = candles[candles.length - 1];
  if (!last || !(atr > 0)) return [];
  const openingBars = o.openingBars ?? 3;
  const start = sessionStartIndex(candles);
  const session = candles.slice(start);
  const out: LiquidityLevel[] = [];

  const prev = dayLevels(priorSession(candles, start));
  if (prev) {
    out.push({ kind: 'PDH', price: prev.high, side: 'HIGH' });
    out.push({ kind: 'PDL', price: prev.low, side: 'LOW' });
  }
  if (session.length > openingBars) {
    const opening = session.slice(0, openingBars);
    out.push({ kind: 'ORH', price: Math.max(...opening.map((b) => b.high)), side: 'HIGH' });
    out.push({ kind: 'ORL', price: Math.min(...opening.map((b) => b.low)), side: 'LOW' });
  }
  const s = swings(session, o.swingLength ?? 2, 0);
  const tol = (o.equalTolAtr ?? 0.1) * atr;
  for (const p of equalLevels(s.highs, tol, 'HIGH')) out.push({ kind: 'EQH', price: p, side: 'HIGH' });
  for (const p of equalLevels(s.lows, tol, 'LOW')) out.push({ kind: 'EQL', price: p, side: 'LOW' });

  if (o.withRound ?? true) {
    const step = roundStep(last.close);
    const below = Math.floor(last.close / step) * step;
    out.push({ kind: 'ROUND', price: below, side: 'LOW' });
    out.push({ kind: 'ROUND', price: below + step, side: 'HIGH' });
    if (below - step > 0) out.push({ kind: 'ROUND', price: below - step, side: 'LOW' });
    out.push({ kind: 'ROUND', price: below + 2 * step, side: 'HIGH' });
  }
  return out;
}

export interface StopGuardOptions {
  /** A stop this close above a support (below a resistance, for shorts) goes with any test of it. */
  readonly zoneAtr?: number;
  /** How far a sweep typically runs past the level. */
  readonly sweepAtr?: number;
  /** The most a stop is moved; a level that needs more is left alone rather than widen risk a lot. */
  readonly maxShiftAtr?: number;
}

/**
 * Move a stop out of a stop cluster. A long's stop sitting just above a
 * support — or just under it, inside the depth a sweep runs to — is taken by
 * the first probe of that level. It goes beyond the level by the sweep depth
 * instead, if that is a small move; otherwise it is left where the strategy
 * put it. Returns the stop unchanged when nothing threatens it.
 */
export function guardStop(
  side: Side, entry: number, stop: number, levels: readonly LiquidityLevel[], atr: number, o: StopGuardOptions = {},
): { stop: number; level: LiquidityLevel | null } {
  if (!(atr > 0)) return { stop, level: null };
  const zone = (o.zoneAtr ?? 0.25) * atr;
  const sweep = (o.sweepAtr ?? 0.25) * atr;
  const maxShift = (o.maxShiftAtr ?? 0.6) * atr;
  const long = side === 'BUY';
  const dir = long ? 1 : -1;
  let current = stop;
  let moved: LiquidityLevel | null = null;
  // A move can expose the stop to the next level out; a few passes settle it.
  for (let pass = 0; pass < 3; pass++) {
    let next: { stop: number; level: LiquidityLevel } | null = null;
    for (const lv of levels) {
      if (lv.side !== (long ? 'LOW' : 'HIGH')) continue;
      if ((entry - lv.price) * dir <= 0) continue; // not between the entry and the stop's side
      const gap = (current - lv.price) * dir; // > 0: stop sits on the entry side of the level
      if (gap > zone || gap < -sweep) continue;
      const safe = lv.price - dir * (sweep + 0.05 * atr);
      if (((current - safe) * dir) <= 0) continue;
      if (!next || (safe - next.stop) * dir < 0) next = { stop: safe, level: lv };
    }
    if (!next || Math.abs(next.stop - stop) > maxShift) break;
    current = next.stop;
    moved = next.level;
  }
  return { stop: current, level: moved };
}

/**
 * A signal with its stop moved out of any stop cluster (see `guardStop`),
 * read from the closed 5-minute bars it was generated on. Entry and target
 * are untouched; only a stop that sat in harm's way moves, and never far.
 */
export function guardSignalStop(signal: Signal, candles: readonly Candle[], o: StopGuardOptions = {}): Signal {
  const a = latest(atr(candles, 14));
  if (a === null || a <= 0) return signal;
  const entry = paiseToRupees(signal.entry);
  const stop = paiseToRupees(signal.stopLoss);
  const g = guardStop(signal.side, entry, stop, liquidityLevels(candles, a), a, o);
  if (g.stop === stop || !g.level) return signal;
  return {
    ...signal,
    stopLoss: rupeesToPaise(g.stop),
    reasons: [...signal.reasons, `stop moved beyond the ${g.level.kind} ₹${g.level.price.toFixed(2)} stop cluster`],
    indicators: { ...(signal.indicators ?? {}), stopGuardLevel: g.level.price, stopBeforeGuard: stop },
  };
}
