import type { Candle } from '@tradeforger/core';
import { istMinutes, SESSION } from '@tradeforger/core';

export interface OpeningRange {
  readonly high: number;
  readonly low: number;
  readonly bars: number;
  readonly complete: boolean;
}

/**
 * Opening Range Breakout — the backbone of the Intraday profile.
 *
 * The range is the high/low of the first N minutes after the open. A close
 * beyond it, with volume, is the classic intraday entry. Requires `complete`
 * before it may be traded: acting on a partial range means breaking out of a
 * level that is still moving.
 */
export function openingRange(candles: readonly Candle[], minutes = 15): OpeningRange | null {
  const rangeEnd = SESSION.OPEN + minutes;
  const inRange = candles.filter((c) => {
    const m = istMinutes(new Date(c.ts));
    return m >= SESSION.OPEN && m < rangeEnd;
  });
  if (inRange.length === 0) return null;

  const lastBar = candles[candles.length - 1];
  const nowMin = lastBar ? istMinutes(new Date(lastBar.ts)) : 0;

  return {
    high: Math.max(...inRange.map((c) => c.high)),
    low: Math.min(...inRange.map((c) => c.low)),
    bars: inRange.length,
    complete: nowMin >= rangeEnd,
  };
}

export type Breakout = 'ABOVE' | 'BELOW' | 'INSIDE';

export function orbState(range: OpeningRange, price: number): Breakout {
  if (price > range.high) return 'ABOVE';
  if (price < range.low) return 'BELOW';
  return 'INSIDE';
}

export interface Level {
  readonly price: number;
  /** How many times price reversed at this level — more touches, stronger. */
  readonly touches: number;
}

/**
 * Swing-pivot support and resistance.
 *
 * A pivot is a bar whose high (or low) exceeds `lookback` bars on both sides.
 * Levels within `tolerance` of each other are merged, because price does not
 * respect a level to the paisa — it respects a zone.
 */
export function findLevels(
  candles: readonly Candle[],
  lookback = 3,
  tolerance = 0.005,
): { support: Level[]; resistance: Level[] } {
  const highs: number[] = [];
  const lows: number[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]!;
    const window = candles.slice(i - lookback, i + lookback + 1);
    if (window.every((w) => c.high >= w.high)) highs.push(c.high);
    if (window.every((w) => c.low <= w.low)) lows.push(c.low);
  }

  const cluster = (prices: readonly number[]): Level[] => {
    const sorted = [...prices].sort((a, b) => a - b);
    const out: Level[] = [];
    for (const p of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(p - last.price) / last.price <= tolerance) {
        out[out.length - 1] = {
          price: (last.price * last.touches + p) / (last.touches + 1),
          touches: last.touches + 1,
        };
      } else {
        out.push({ price: p, touches: 1 });
      }
    }
    return out.sort((a, b) => b.touches - a.touches);
  };

  return { support: cluster(lows), resistance: cluster(highs) };
}

/** Gap between yesterday's close and today's open, as a fraction. */
export function gapPct(prevClose: number, todayOpen: number): number {
  return prevClose === 0 ? 0 : (todayOpen - prevClose) / prevClose;
}
