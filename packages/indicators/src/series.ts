import type { Candle } from '@tradeforger/core';

/**
 * Indicator outputs are `(number | null)[]`, aligned index-for-index with the
 * input candles. Null means "not enough history yet" — an explicit gap rather
 * than a zero or a silently shortened array, both of which cause an off-by-one
 * between an indicator value and the bar it belongs to. That class of bug is
 * invisible in a chart and fatal in an autonomous system.
 */
export type Series = (number | null)[];

export const closes = (c: readonly Candle[]): number[] => c.map((x) => x.close);
export const highs = (c: readonly Candle[]): number[] => c.map((x) => x.high);
export const lows = (c: readonly Candle[]): number[] => c.map((x) => x.low);
export const volumes = (c: readonly Candle[]): number[] => c.map((x) => x.volume);

/** Most recent non-null value, or null if the series never warmed up. */
export function latest(s: Series): number | null {
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Value `n` bars back from the end. */
export function prior(s: Series, n: number): number | null {
  const v = s[s.length - 1 - n];
  return v ?? null;
}
