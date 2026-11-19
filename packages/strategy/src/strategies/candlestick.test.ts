import { describe, it, expect } from 'vitest';
import type { Candle } from '@tradeforger/core';
import { detectPatterns, DEFAULT_CANDLESTICK } from './candlestick.ts';

const bar = (open: number, high: number, low: number, close: number): Candle => ({ ts: 0, open, high, low, close, volume: 1000 });
const flat = bar(100, 101, 99, 100);

describe('candlestick patterns', () => {
  it('reads a hammer only after a decline', () => {
    const hammer = bar(100, 100.6, 96, 100.5);
    expect(detectPatterns([flat, flat, hammer], DEFAULT_CANDLESTICK, true, false).bullish).toContain('Hammer');
    expect(detectPatterns([flat, flat, hammer], DEFAULT_CANDLESTICK, false, true).bullish).not.toContain('Hammer');
  });

  it('finds a bullish engulfing and ignores one made of tiny candles', () => {
    const down = bar(101, 101.5, 99.5, 100);
    const up = bar(99.8, 102.2, 99.6, 102);
    expect(detectPatterns([flat, down, up], DEFAULT_CANDLESTICK, true, false).bullish).toContain('Bullish engulfing');
    expect(detectPatterns([flat, down, up], DEFAULT_CANDLESTICK, true, false, 5).bullish).not.toContain('Bullish engulfing');
  });

  it('finds three black crows', () => {
    const crows = [bar(106, 106.2, 103.8, 104), bar(104.5, 104.6, 101.8, 102), bar(102.4, 102.5, 99.7, 100)];
    expect(detectPatterns(crows, DEFAULT_CANDLESTICK, false, true).bearish).toContain('Three black crows');
  });
});
