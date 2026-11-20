import { describe, it, expect } from 'vitest';
import type { Candle } from '@tradeforger/core';
import { StockScanner } from './scanner.ts';

function synthesizeCandles(count: number, breakout = true): Candle[] {
  const base = new Date('2026-09-14T03:45:00Z').getTime();
  const out: Candle[] = [];
  let price = 1000;

  for (let i = 0; i < count; i++) {
    if (breakout && i >= 12) {
      price += 5.0; // breakout above
    } else {
      price += (i % 2 === 0 ? 0.5 : -0.5);
    }

    out.push({
      ts: base + i * 5 * 60_000,
      open: price - 1,
      high: price + 3,
      low: price - 2,
      close: price,
      volume: i >= count - 3 ? 10000 : 2000,
    });
  }
  return out;
}

describe('StockScanner', () => {
  const scanner = new StockScanner();

  it('ranks breaking-out stocks with volume ahead of flat stocks', () => {
    const universe = [
      { instrumentKey: 'NSE_EQ|FLAT', symbol: 'FLAT', name: 'Flat Stock' },
      { instrumentKey: 'NSE_EQ|BREAK', symbol: 'BREAK', name: 'Breakout Stock' },
    ];

    const candleMap = new Map<string, Candle[]>([
      ['NSE_EQ|FLAT', synthesizeCandles(30, false)],
      ['NSE_EQ|BREAK', synthesizeCandles(30, true)],
    ]);

    const ranked = scanner.rankUniverse(universe, candleMap);

    expect(ranked.length).toBe(2);
    expect(ranked[0]!.symbol).toBe('BREAK');
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[0]!.tradeSetup).not.toBeNull();

    const setup = ranked[0]!.tradeSetup!;
    expect(setup.side).toBe('BUY');
    expect(setup.target1).toBeGreaterThan(setup.entry);
    expect(setup.stopLoss).toBeLessThan(setup.entry);
    expect(setup.rewardToRisk1).toBe(1.5);
    expect(setup.rewardToRisk2).toBe(2.5);
  });

  it('filters out stocks outside minPrice and maxPrice range', () => {
    const universe = [
      { instrumentKey: 'NSE_EQ|LOW', symbol: 'LOW', name: 'Low Price Stock' },
      { instrumentKey: 'NSE_EQ|MID', symbol: 'MID', name: 'Mid Price Stock' },
      { instrumentKey: 'NSE_EQ|HIGH', symbol: 'HIGH', name: 'High Price Stock' },
    ];

    // synthesizeCandles starts at price = 1000
    // Let's create candles with custom prices
    const mkCandles = (p: number) => {
      const base = new Date('2026-09-14T03:45:00Z').getTime();
      return Array.from({ length: 20 }, (_, i) => ({
        ts: base + i * 5 * 60_000,
        open: p,
        high: p + 2,
        low: p - 2,
        close: p,
        volume: 5000,
      }));
    };

    const candleMap = new Map<string, Candle[]>([
      ['NSE_EQ|LOW', mkCandles(50)],    // ₹50
      ['NSE_EQ|MID', mkCandles(250)],   // ₹250
      ['NSE_EQ|HIGH', mkCandles(12000)], // ₹12,000 (e.g. Maruti)
    ]);

    // Filter between 100 and 500
    const filtered = scanner.rankUniverse(universe, candleMap, { minPrice: 100, maxPrice: 500 });
    expect(filtered.length).toBe(1);
    expect(filtered[0]!.symbol).toBe('MID');
  });
});

