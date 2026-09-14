import { describe, it, expect } from 'vitest';
import type { Candle } from '@tradeforger/core';
import { sma, ema, macd, atr, trueRange, supertrend, adx } from './trend.ts';
import { rsi, bollinger, stochastic, vwap, relativeVolume } from './momentum.ts';
import { openingRange, orbState, findLevels, gapPct } from './structure.ts';
import { latest } from './series.ts';

/** Candles at a fixed IST time; ts drives VWAP's daily reset and ORB windows. */
function mk(closes: number[], startIso = '2026-09-14T03:45:00Z'): Candle[] {
  const base = new Date(startIso).getTime();
  return closes.map((c, i) => ({
    ts: base + i * 5 * 60_000,
    open: c, high: c + 1, low: c - 1, close: c, volume: 1000,
  }));
}

describe('alignment — the invariant everything else depends on', () => {
  it('every indicator returns a series the same length as its input', () => {
    const data = Array.from({ length: 50 }, (_, i) => 100 + i);
    const candles = mk(data);
    expect(sma(data, 10)).toHaveLength(50);
    expect(ema(data, 10)).toHaveLength(50);
    expect(rsi(data, 14)).toHaveLength(50);
    expect(atr(candles, 14)).toHaveLength(50);
    expect(vwap(candles)).toHaveLength(50);
    expect(supertrend(candles).value).toHaveLength(50);
    expect(adx(candles).adx).toHaveLength(50);
    expect(macd(data).macd).toHaveLength(50);
    expect(bollinger(data).upper).toHaveLength(50);
  });

  it('pads with null rather than shortening — a shorter array desyncs the bar index', () => {
    expect(sma([1, 2, 3, 4, 5], 3).slice(0, 2)).toEqual([null, null]);
    expect(ema([1, 2, 3, 4, 5], 3).slice(0, 2)).toEqual([null, null]);
  });

  it('returns all-null when there is not enough history', () => {
    expect(ema([1, 2], 10).every((v) => v === null)).toBe(true);
    expect(rsi([1, 2, 3], 14).every((v) => v === null)).toBe(true);
  });
});

describe('SMA', () => {
  it('averages the window', () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it('stays exact over a long series (no accumulator drift)', () => {
    const data = Array.from({ length: 500 }, (_, i) => i + 1);
    // Rolling-sum optimisation must still agree with the naive mean.
    expect(latest(sma(data, 10))).toBeCloseTo(495.5, 9);
  });
});

describe('EMA', () => {
  it('seeds from the SMA of the first period, matching TradingView', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[2]).toBe(2); // SMA(1,2,3)
    expect(out[3]).toBeCloseTo(3, 10); // (4-2)*0.5+2
  });
  it('converges toward a constant series', () => {
    expect(latest(ema(new Array(100).fill(50), 10))).toBeCloseTo(50, 9);
  });
});

describe('RSI — Wilder smoothing', () => {
  it('is 100 for an unbroken advance', () => {
    expect(latest(rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14))).toBe(100);
  });
  it('is 0 for an unbroken decline', () => {
    expect(latest(rsi(Array.from({ length: 40 }, (_, i) => 200 - i), 14))).toBeCloseTo(0, 6);
  });
  it('sits near 50 for an alternating series', () => {
    const data = Array.from({ length: 60 }, (_, i) => (i % 2 ? 101 : 100));
    const v = latest(rsi(data, 14))!;
    expect(v).toBeGreaterThan(35);
    expect(v).toBeLessThan(65);
  });
  it('stays within 0..100 on noisy data', () => {
    const data = Array.from({ length: 200 }, () => 100 + Math.random() * 20);
    for (const v of rsi(data, 14)) {
      if (v !== null) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(100); }
    }
  });
});

describe('True Range and ATR', () => {
  it('first bar TR is simply high minus low', () => {
    expect(trueRange(mk([100]))[0]).toBe(2);
  });
  it('TR accounts for a gap from the previous close', () => {
    const candles: Candle[] = [
      { ts: 0, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { ts: 1, open: 110, high: 112, low: 109, close: 111, volume: 1 },
    ];
    expect(trueRange(candles)[1]).toBe(12); // 112 - 100, not 112 - 109
  });
  it('ATR is positive and finite on real-shaped data', () => {
    const v = latest(atr(mk(Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i) * 5)), 14))!;
    expect(v).toBeGreaterThan(0);
    expect(Number.isFinite(v)).toBe(true);
  });
});

describe('Supertrend', () => {
  it('reports an uptrend on a rising series', () => {
    const st = supertrend(mk(Array.from({ length: 60 }, (_, i) => 100 + i * 2)), 10, 3);
    expect(st.direction[st.direction.length - 1]).toBe(1);
  });
  it('reports a downtrend on a falling series', () => {
    const st = supertrend(mk(Array.from({ length: 60 }, (_, i) => 200 - i * 2)), 10, 3);
    expect(st.direction[st.direction.length - 1]).toBe(-1);
  });
  it('keeps the line below price in an uptrend', () => {
    const candles = mk(Array.from({ length: 60 }, (_, i) => 100 + i * 2));
    const st = supertrend(candles, 10, 3);
    const i = candles.length - 1;
    expect(st.value[i]!).toBeLessThan(candles[i]!.close);
  });
});

describe('ADX', () => {
  it('reads high on a strong trend', () => {
    expect(latest(adx(mk(Array.from({ length: 80 }, (_, i) => 100 + i * 3)), 14).adx)!)
      .toBeGreaterThan(25);
  });
  it('reads low on a choppy range', () => {
    const data = Array.from({ length: 80 }, (_, i) => 100 + (i % 4 < 2 ? 1 : -1));
    expect(latest(adx(mk(data), 14).adx)!).toBeLessThan(25);
  });
});

describe('MACD', () => {
  it('matches the analytical value on a linear ramp', () => {
    // An EMA of period n lags a ramp of slope m by (n-1)/2 * m, so
    // MACD = m * ((26-1)/2 - (12-1)/2) = 7m. With m = 2 that is exactly 14.
    expect(latest(macd(Array.from({ length: 200 }, (_, i) => 100 + i * 2)).macd)!)
      .toBeCloseTo(14, 4);
  });

  it('histogram converges to zero on a linear ramp, not to a positive number', () => {
    // The MACD line is constant on a ramp, so its signal EMA converges to the
    // same constant. A non-zero histogram here would mean the signal EMA is
    // seeded or aligned wrongly.
    expect(latest(macd(Array.from({ length: 200 }, (_, i) => 100 + i * 2)).histogram)!)
      .toBeCloseTo(0, 6);
  });

  it('histogram turns positive on acceleration and negative on deceleration', () => {
    const accel = macd(Array.from({ length: 200 }, (_, i) => 100 + i * i * 0.05));
    const decel = macd(Array.from({ length: 200 }, (_, i) => 100 + Math.sqrt(i) * 20));
    expect(latest(accel.histogram)!).toBeGreaterThan(0);
    expect(latest(decel.histogram)!).toBeLessThan(0);
  });
  it('signal line is null until the MACD line itself has warmed up', () => {
    const r = macd(Array.from({ length: 80 }, (_, i) => 100 + i));
    expect(r.signal[20]).toBeNull();
    expect(latest(r.signal)).not.toBeNull();
  });
});

describe('Bollinger Bands', () => {
  it('orders the bands and reports zero width on a flat series', () => {
    const b = bollinger(new Array(40).fill(100), 20, 2);
    expect(latest(b.upper)).toBeCloseTo(100, 9);
    expect(latest(b.bandwidth)).toBeCloseTo(0, 9);
  });
  it('widens with volatility', () => {
    const calm = bollinger(Array.from({ length: 40 }, (_, i) => 100 + (i % 2)), 20, 2);
    const wild = bollinger(Array.from({ length: 40 }, (_, i) => 100 + (i % 2) * 20), 20, 2);
    expect(latest(wild.bandwidth)!).toBeGreaterThan(latest(calm.bandwidth)!);
  });
});

describe('VWAP resets daily', () => {
  it('restarts at the session boundary instead of drifting into a long-run mean', () => {
    const day1 = mk([100, 100, 100], '2026-09-14T04:00:00Z');
    const day2 = mk([200, 200, 200], '2026-09-15T04:00:00Z');
    const out = vwap([...day1, ...day2]);
    expect(out[2]).toBeCloseTo(100, 6);
    // Without a daily reset this would sit near 150.
    expect(out[5]).toBeCloseTo(200, 6);
  });
});

describe('relative volume', () => {
  it('flags a volume spike', () => {
    const candles = mk(new Array(25).fill(100));
    candles[24] = { ...candles[24]!, volume: 5000 };
    expect(latest(relativeVolume(candles, 20))!).toBeCloseTo(5, 1);
  });
});

describe('Opening Range Breakout', () => {
  // 09:15 IST = 03:45 UTC
  const session = (n: number) => mk(Array.from({ length: n }, () => 100), '2026-09-14T03:45:00Z');

  it('is incomplete while still inside the first 15 minutes', () => {
    const r = openingRange(session(2), 15)!;
    expect(r.complete).toBe(false);
  });

  it('completes once price moves past the window', () => {
    const r = openingRange(session(6), 15)!;
    expect(r.complete).toBe(true);
    expect(r.bars).toBe(3); // 09:15, 09:20, 09:25
  });

  it('classifies breakouts against the range', () => {
    const r = openingRange(session(6), 15)!;
    expect(orbState(r, r.high + 1)).toBe('ABOVE');
    expect(orbState(r, r.low - 1)).toBe('BELOW');
    expect(orbState(r, (r.high + r.low) / 2)).toBe('INSIDE');
  });

  it('returns null when no candles fall in the session window', () => {
    expect(openingRange(mk([100], '2026-09-14T12:00:00Z'), 15)).toBeNull();
  });
});

describe('support and resistance', () => {
  it('finds pivots and merges nearby levels into zones', () => {
    const prices = [100, 105, 100, 95, 100, 105, 100, 95, 100, 105, 100];
    const { support, resistance } = findLevels(mk(prices), 2, 0.01);
    expect(support.length).toBeGreaterThan(0);
    expect(resistance.length).toBeGreaterThan(0);
    expect(support[0]!.touches).toBeGreaterThanOrEqual(1);
  });
});

describe('gap', () => {
  it('measures overnight gaps in both directions', () => {
    expect(gapPct(100, 102)).toBeCloseTo(0.02, 9);
    expect(gapPct(100, 98)).toBeCloseTo(-0.02, 9);
    expect(gapPct(0, 100)).toBe(0);
  });
});
