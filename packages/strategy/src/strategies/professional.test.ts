import { describe, it, expect } from 'vitest';
import { FixedClock, type Candle } from '@tradeforger/core';
import type { StrategyDefinition } from '../definition.ts';
import { HOLY_GRAIL_15M, INSIDE_BAR_15M } from './professional.ts';

/** [open, high, low, close, volume] */
type Bar = [number, number, number, number, number];

const at15 = (date: string, i: number): number => Date.parse(`${date}T09:15:00+05:30`) + i * 900_000;
const day = (date: string, bars: readonly Bar[]): Candle[] =>
  bars.map(([open, high, low, close, volume], i) => ({ ts: at15(date, i), open, high, low, close, volume }));
const quiet = (n: number, px: number, volume = 1000): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const [o, c] = i % 2 ? [px + 0.05, px - 0.05] : [px - 0.05, px + 0.05];
    return [o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, volume];
  });

/** Evaluate at the close of the last 15-minute bar. */
function run(def: StrategyDefinition, candles: readonly Candle[]) {
  const clock = new FixedClock(new Date(candles[candles.length - 1]!.ts + 900_000));
  return def.create().evaluate({ instrumentKey: 'K', symbol: 'S', candles, higherTf: [], clock });
}

describe('Inside bar at a key level', () => {
  // Yesterday closed near 100.9, so its high (≈101) is the level today coils under.
  const history = [...day('2026-01-05', quiet(25, 100.9)), ...day('2026-01-06', quiet(25, 100.9))];
  const mother: Bar = [100.6, 101.2, 100.5, 101.0, 1000];
  const inside: Bar = [100.9, 101.1, 100.7, 101.0, 800];
  const breakout: Bar = [101.0, 101.8, 100.95, 101.7, 3000];

  it('buys a close beyond the mother bar on volume, stop toward its other end', () => {
    const s = run(INSIDE_BAR_15M, [...history, ...day('2026-01-07', [...quiet(3, 100.9), mother, inside, breakout])]);
    expect(s?.side).toBe('BUY');
    expect(s!.stopLoss).toBeLessThan(s!.entry);
    expect(s!.indicators?.['triggerPrice']).toBe(101.2);
  });

  it('skips a thin breakout and a bar that is not inside', () => {
    const thin: Bar = [101.0, 101.8, 100.95, 101.7, 900];
    expect(run(INSIDE_BAR_15M, [...history, ...day('2026-01-07', [...quiet(3, 100.9), mother, inside, thin])])).toBeNull();
    const outside: Bar = [100.9, 101.3, 100.7, 101.0, 800];
    expect(run(INSIDE_BAR_15M, [...history, ...day('2026-01-07', [...quiet(3, 100.9), mother, outside, breakout])])).toBeNull();
  });
});

describe('Holy Grail pullback', () => {
  // A steady trend: each 15-minute bar 0.4 higher with small ranges — ADX well above 30.
  const trend = (n: number, from: number): Bar[] =>
    Array.from({ length: n }, (_, i) => {
      const o = from + i * 0.4;
      return [o, o + 0.5, o - 0.1, o + 0.4, 1000];
    });
  const history = [...day('2026-01-05', trend(25, 100)), ...day('2026-01-06', trend(25, 110))];
  const todayUp = trend(8, 120);
  const top = 120 + 8 * 0.4;

  /** Pull back to the 20-EMA (≈ 3.8 under price in this trend), then a bar breaking the pullback bar's high. */
  const pullback: Bar[] = [[top, top + 0.1, top - 2.2, top - 2.0, 800], [top - 2.0, top - 1.8, top - 4.4, top - 3.6, 800]];
  const trigger: Bar = [top - 3.6, top - 1.0, top - 3.7, top - 1.2, 1500];

  it('buys the first bar to break the pullback bar in a strong uptrend', () => {
    const s = run(HOLY_GRAIL_15M, [...history, ...day('2026-01-07', [...todayUp, ...pullback, trigger])]);
    expect(s?.side).toBe('BUY');
    expect(s!.stopLoss).toBeLessThan(s!.entry);
    expect(s!.indicators?.['adx']).toBeGreaterThanOrEqual(30);
  });

  it('skips when the pullback never reached the EMA', () => {
    const shallow: Bar[] = [[top, top + 0.1, top - 0.6, top - 0.4, 800], [top - 0.4, top - 0.2, top - 0.9, top - 0.6, 800]];
    const brk: Bar = [top - 0.6, top + 0.4, top - 0.7, top + 0.3, 1500];
    expect(run(HOLY_GRAIL_15M, [...history, ...day('2026-01-07', [...todayUp, ...shallow, brk])])).toBeNull();
  });
});
