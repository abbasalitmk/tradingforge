import { describe, it, expect } from 'vitest';
import { planChunks, candleDivergence, DIVERGENCE_TOLERANCE } from './backfill.ts';
import { CandleAggregator } from './aggregate.ts';
import type { Tick } from '@tradeforger/core';

describe('chunk planner respects Upstox per-unit span limits', () => {
  it('splits a year of 1-minute candles into ~monthly requests', () => {
    const chunks = planChunks('minutes', 1, '2026-01-01', '2026-12-31');
    expect(chunks.length).toBeGreaterThan(11);
    // Exceeding 30 days returns an error rather than truncating, so no chunk may.
    for (const c of chunks) {
      const days = (new Date(c.to).getTime() - new Date(c.from).getTime()) / 86_400_000;
      expect(days).toBeLessThan(30);
    }
  });

  it('allows a quarter per request above 15-minute intervals', () => {
    const chunks = planChunks('minutes', 30, '2026-01-01', '2026-12-31');
    expect(chunks.length).toBeLessThan(planChunks('minutes', 1, '2026-01-01', '2026-12-31').length);
  });

  it('fetches a decade of daily candles in one request', () => {
    expect(planChunks('days', 1, '2020-01-01', '2026-09-14')).toHaveLength(1);
  });

  it('clamps to the earliest date Upstox holds for the unit', () => {
    // Minute data starts Jan 2022; asking for 2015 must not produce 2015 chunks.
    const chunks = planChunks('minutes', 1, '2015-01-01', '2022-03-01');
    expect(chunks.every((c) => c.from >= '2022-01-01')).toBe(true);
  });

  it('returns newest chunks first so partial backfills are still useful', () => {
    const chunks = planChunks('minutes', 1, '2026-01-01', '2026-06-30');
    expect(chunks[0]!.to > chunks[chunks.length - 1]!.to).toBe(true);
  });

  it('returns nothing for an inverted range', () => {
    expect(planChunks('days', 1, '2026-09-14', '2026-01-01')).toHaveLength(0);
  });

  it('covers the full requested range without gaps', () => {
    const chunks = planChunks('minutes', 1, '2026-01-01', '2026-04-30');
    const sorted = [...chunks].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < sorted.length; i++) {
      const prevTo = new Date(sorted[i - 1]!.to).getTime();
      const thisFrom = new Date(sorted[i]!.from).getTime();
      expect(thisFrom - prevTo).toBe(86_400_000); // exactly one day apart
    }
  });
});

describe('candle divergence guard', () => {
  const c = (close: number) => ({ ts: 0, open: 0, high: 0, low: 0, close, volume: 0 });

  it('accepts a locally-built candle matching the exchange', () => {
    expect(candleDivergence(c(1000), c(1000))).toBe(0);
  });

  it('flags a 0.5% mismatch as beyond tolerance', () => {
    expect(candleDivergence(c(1005), c(1000))).toBeGreaterThan(DIVERGENCE_TOLERANCE);
  });

  it('tolerates rounding-level differences', () => {
    expect(candleDivergence(c(1000.05), c(1000))).toBeLessThan(DIVERGENCE_TOLERANCE);
  });
});

describe('CandleAggregator', () => {
  const KEY = 'NSE_EQ|TEST';
  const tick = (ltp: number, ts: number): Tick => ({ instrumentKey: KEY, ltp, ltq: 10, ts });
  const base = new Date('2026-09-14T04:00:00Z').getTime();

  it('builds OHLC across ticks within one bucket', () => {
    const agg = new CandleAggregator(5);
    agg.push(tick(100, base));
    agg.push(tick(105, base + 60_000));
    agg.push(tick(95, base + 120_000));
    agg.push(tick(102, base + 180_000));

    const open = agg.peek(KEY)!;
    expect(open).toMatchObject({ open: 100, high: 105, low: 95, close: 102, volume: 40 });
  });

  it('emits the completed candle when the bucket rolls over', () => {
    const agg = new CandleAggregator(5);
    agg.push(tick(100, base));
    agg.push(tick(110, base + 60_000));
    const closed = agg.push(tick(120, base + 5 * 60_000));

    expect(closed).toMatchObject({ open: 100, high: 110, close: 110 });
    expect(agg.peek(KEY)).toMatchObject({ open: 120, close: 120 });
  });

  it('aligns buckets to the interval, not to the first tick', () => {
    const agg = new CandleAggregator(5);
    // First tick arrives mid-bucket at 04:03.
    agg.push(tick(100, base + 3 * 60_000));
    expect(agg.peek(KEY)!.ts).toBe(base); // bucket starts at 04:00
  });

  it('drops out-of-order ticks rather than corrupting the bar', () => {
    const agg = new CandleAggregator(5);
    agg.push(tick(100, base + 2 * 60_000));
    agg.push(tick(999, base - 10 * 60_000)); // stale frame
    expect(agg.peek(KEY)!.high).toBe(100);
  });

  it('keeps instruments independent', () => {
    const agg = new CandleAggregator(5);
    agg.push(tick(100, base));
    agg.push({ instrumentKey: 'NSE_EQ|OTHER', ltp: 500, ltq: 1, ts: base });
    expect(agg.peek(KEY)!.close).toBe(100);
    expect(agg.peek('NSE_EQ|OTHER')!.close).toBe(500);
  });

  it('takes volume from the cumulative day volume, not from ltq', () => {
    const agg = new CandleAggregator(5);
    // Three frames; the middle one coalesced 500 shares of trades but ltq says 10.
    agg.push({ instrumentKey: KEY, ltp: 100, ltq: 10, volume: 1_000, ts: base });
    agg.push({ instrumentKey: KEY, ltp: 101, ltq: 10, volume: 1_500, ts: base + 1_000 });
    agg.push({ instrumentKey: KEY, ltp: 102, ltq: 10, volume: 1_520, ts: base + 2_000 });
    expect(agg.peek(KEY)!.volume).toBe(10 + 500 + 20);
  });

  it('flush closes every open bar', () => {
    const agg = new CandleAggregator(5);
    agg.push(tick(100, base));
    agg.push({ instrumentKey: 'NSE_EQ|OTHER', ltp: 500, ltq: 1, ts: base });
    expect(agg.flush()).toHaveLength(2);
    expect(agg.peek(KEY)).toBeNull();
  });
});
