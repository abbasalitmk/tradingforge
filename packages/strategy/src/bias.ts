import { type Candle, type Side, istMinutes } from '@tradeforger/core';
import { adx, ema, latest, vwap } from '@tradeforger/indicators';
import { resample15 } from './strategies/gmma.ts';
import { sessionStartIndex, priorSession } from './strategies/common.ts';

/** The 15-minute trend a 5-minute entry must agree with. */
export interface TrendBias {
  /** Full alignment: VWAP side, EMA20/50 and ADX all agree. */
  readonly side: Side | null;
  /** Which side of session VWAP the last complete 15-min close is on; null without volume. */
  readonly vwapSide: Side | null;
  /** Which way EMA20 sits against EMA50 on the 15-min chart. */
  readonly emaSide: Side | null;
  readonly close: number | null;
  readonly vwap: number | null;
  readonly ema20: number | null;
  readonly ema50: number | null;
  readonly adx: number | null;
  readonly reason: string;
}

/** Below this ADX the 15-minute chart is ranging, and neither side has a trend to trade with. */
export const BIAS_MIN_ADX = 20;

const SESSION_OPEN_MIN = 9 * 60 + 15;

/** A 15-minute bar is complete once its third 5-minute bar has closed. */
export function completeBars15(closed5m: readonly Candle[]): Candle[] {
  const bars = resample15(closed5m);
  const last = closed5m[closed5m.length - 1];
  if (last && (istMinutes(new Date(last.ts)) - SESSION_OPEN_MIN) % 15 !== 10) bars.pop();
  return bars;
}

/**
 * Higher-timeframe bias from CLOSED bars only: long when the last complete
 * 15-minute close is above session VWAP, EMA20 is above EMA50 and ADX shows a
 * trend; short on the mirror; otherwise none. An index (no volume) skips VWAP.
 * Intraday entries trade only with it, so a 5-minute trigger against the
 * 15-minute trend is skipped.
 */
export function trendBias15(closed5m: readonly Candle[], minAdx = BIAS_MIN_ADX): TrendBias {
  const bars = completeBars15(closed5m);
  const closes = bars.map((b) => b.close);
  const close = closes[closes.length - 1] ?? null;
  const e20 = latest(ema(closes, 20));
  const e50 = latest(ema(closes, 50));
  const a = latest(adx(bars, 14).adx);
  const vw = latest(vwap(closed5m));
  const sideOf = (x: number | null, y: number | null): Side | null => (x === null || y === null || x === y ? null : x > y ? 'BUY' : 'SELL');
  const base = { close, vwap: vw, ema20: e20, ema50: e50, adx: a, vwapSide: sideOf(close, vw), emaSide: sideOf(e20, e50) };
  if (close === null || e20 === null || e50 === null || a === null) {
    return { ...base, side: null, reason: `not enough 15-min history (${bars.length} bars, EMA50 needs 50)` };
  }
  const f = (x: number): string => x.toFixed(2);
  if (a < minAdx) return { ...base, side: null, reason: `15-min ADX ${a.toFixed(1)} < ${minAdx} — no trend` };
  // An index trades no volume, so it has no VWAP; its bias rests on the EMAs and ADX.
  const above = vw === null || close > vw;
  const below = vw === null || close < vw;
  const vwapNote = vw === null ? 'no volume, VWAP n/a' : `close ${f(close)} ${close > vw ? '>' : '<'} VWAP ${f(vw)}`;
  if (above && e20 > e50) return { ...base, side: 'BUY', reason: `15-min up: ${vwapNote}, EMA20 > EMA50, ADX ${a.toFixed(1)}` };
  if (below && e20 < e50) return { ...base, side: 'SELL', reason: `15-min down: ${vwapNote}, EMA20 < EMA50, ADX ${a.toFixed(1)}` };
  return { ...base, side: null, reason: `15-min mixed: ${vwapNote}, EMA20 ${e20 > e50 ? 'above' : 'below'} EMA50` };
}

/**
 * The market's direction today, from the index's closed 5-minute bars: up
 * when its 15-minute EMA20 is over EMA50 and it trades above today's open,
 * down on the mirror, otherwise none. Professionals buy strength in a rising
 * market and short weakness in a falling one; on two months of NSE 5-minute
 * data, trend entries taken only with the NIFTY were better in both months.
 */
export function marketDirection(closed5m: readonly Candle[]): Side | null {
  const last = closed5m[closed5m.length - 1];
  if (!last) return null;
  const open = closed5m[sessionStartIndex(closed5m)]!.open;
  const { emaSide } = trendBias15(closed5m);
  if (emaSide === 'BUY' && last.close > open) return 'BUY';
  if (emaSide === 'SELL' && last.close < open) return 'SELL';
  return null;
}

/** Today's change from the previous session's close, %, or null without a previous session. */
export function dayChangePct(closed5m: readonly Candle[]): number | null {
  const last = closed5m[closed5m.length - 1];
  const prev = priorSession(closed5m, sessionStartIndex(closed5m));
  const prevClose = prev[prev.length - 1]?.close;
  return last && prevClose ? ((last.close - prevClose) / prevClose) * 100 : null;
}
