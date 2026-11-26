import { describe, it, expect } from 'vitest';
import type { Candle } from '@tradeforger/core';
import { liquidityLevels, guardStop, roundStep, type LiquidityLevel } from './liquidity.ts';

/** [open, high, low, close] */
type Bar = [number, number, number, number];
const day = (date: string, bars: readonly Bar[]): Candle[] =>
  bars.map(([open, high, low, close], i) => ({ ts: Date.parse(`${date}T09:15:00+05:30`) + i * 300_000, open, high, low, close, volume: 1000 }));

describe('liquidity levels', () => {
  // Yesterday 99–103; today opens 101–102 and twice bottoms at ~100.50 (equal lows, as PNB did on 23 Nov).
  const yesterday: Bar[] = [[100, 103, 99, 101], [101, 102, 100, 101.5]];
  const today: Bar[] = [
    [101.5, 102, 101.2, 101.8], [101.8, 101.9, 101.1, 101.3], [101.3, 101.6, 101, 101.4],
    [101.4, 101.5, 100.8, 100.9], [100.9, 101, 100.5, 100.7], [100.7, 101.1, 100.6, 101],
    [101, 101.2, 100.9, 101.1], [101.1, 101.2, 100.52, 100.8], [100.8, 101.3, 100.7, 101.2], [101.2, 101.4, 101, 101.3],
  ];
  const levels = liquidityLevels([...day('2026-01-05', yesterday), ...day('2026-01-06', today)], 0.5);
  const has = (kind: LiquidityLevel['kind'], price: number) => levels.some((l) => l.kind === kind && Math.abs(l.price - price) < 1e-9);

  it('finds the previous day high and low, the opening range and equal lows', () => {
    expect(has('PDH', 103)).toBe(true);
    expect(has('PDL', 99)).toBe(true);
    expect(has('ORH', 102)).toBe(true);
    expect(has('ORL', 101)).toBe(true);
    expect(has('EQL', 100.5)).toBe(true);
  });

  it('spaces round numbers by price', () => {
    expect(roundStep(40)).toBe(1);
    expect(roundStep(150)).toBe(5);
    expect(roundStep(700)).toBe(10);
    expect(roundStep(2500)).toBe(50);
  });
});

describe('stop guard', () => {
  const lows: LiquidityLevel[] = [{ kind: 'EQL', price: 150.5, side: 'LOW' }];

  it('moves a long stop sitting on equal lows to beyond the sweep zone (PNB: stop 150.51 on lows at 150.50)', () => {
    const g = guardStop('BUY', 151.95, 150.51, lows, 0.6);
    expect(g.level?.kind).toBe('EQL');
    expect(g.stop).toBeCloseTo(150.5 - 0.3 * 0.6, 6);
  });

  it('leaves a stop alone when nothing is near it, or when protecting it would widen risk too much', () => {
    expect(guardStop('BUY', 151.95, 149.5, lows, 0.6)).toEqual({ stop: 149.5, level: null });
    // Just inside the 0.25 ATR zone above the level is exposed; moving it needs ~0.53 ATR, inside the 0.6 cap.
    expect(guardStop('BUY', 151.95, 150.64, lows, 0.6).level?.kind).toBe('EQL');
    expect(guardStop('BUY', 151.95, 150.64, lows, 0.6, { maxShiftAtr: 0.3 })).toEqual({ stop: 150.64, level: null });
  });

  it('mirrors for a short above equal highs, and ignores levels on the wrong side', () => {
    const highs: LiquidityLevel[] = [{ kind: 'PDH', price: 212, side: 'HIGH' }];
    expect(guardStop('SELL', 210.8, 211.95, highs, 1).stop).toBeCloseTo(212.3, 6);
    expect(guardStop('BUY', 210.8, 209.9, highs, 1).level).toBeNull();
  });
});
