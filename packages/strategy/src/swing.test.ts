import { describe, it, expect } from 'vitest';
import { FixedClock, type Candle, paiseToRupees } from '@tradeforger/core';
import { SwingProfile, DEFAULT_SWING } from './swing.ts';

function synthesizeDailyCandles(opts: {
  bars: number;
  trend?: 'bull' | 'bear' | 'flat';
  pullbackAtEnd?: boolean;
}): Candle[] {
  const { bars, trend = 'bull', pullbackAtEnd = true } = opts;
  const base = new Date('2026-01-01T00:00:00Z').getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const out: Candle[] = [];
  let price = 500;

  for (let i = 0; i < bars; i++) {
    const isEnd = i >= bars - 5;
    if (trend === 'bull') {
      if (pullbackAtEnd && isEnd) {
        // slight pullback towards EMA20
        price -= 0.6;
      } else {
        price += 1.2;
      }
    } else if (trend === 'bear') {
      if (pullbackAtEnd && isEnd) {
        price += 0.6;
      } else {
        price -= 1.2;
      }
    } else {
      price += (i % 2 === 0 ? 0.4 : -0.4);
    }

    const volume = i >= bars - 2 ? 3000 : 1500;
    out.push({
      ts: base + i * dayMs,
      open: price - 0.5,
      high: price + 1.5,
      low: price - 1.5,
      close: price,
      volume,
    });
  }
  return out;
}

const clock = () => new FixedClock(new Date('2026-06-01T10:00:00Z'));

const makeCtx = (candles: Candle[]) => ({
  instrumentKey: 'NSE_EQ|INFY',
  symbol: 'INFY',
  candles,
  higherTf: [],
  clock: clock(),
});

describe('SwingProfile', () => {
  it('returns null if warmup bars are insufficient', () => {
    const profile = new SwingProfile();
    const candles = synthesizeDailyCandles({ bars: 20 });
    expect(profile.evaluate(makeCtx(candles))).toBeNull();
  });

  it('generates a BUY swing signal on a confirmed bullish trend pullback', () => {
    const profile = new SwingProfile({ ...DEFAULT_SWING, minConfidence: 50 });
    const candles = synthesizeDailyCandles({ bars: 75, trend: 'bull', pullbackAtEnd: true });
    const signal = profile.evaluate(makeCtx(candles));

    expect(signal).not.toBeNull();
    if (!signal) return;

    expect(signal.style).toBe('SWING');
    expect(signal.side).toBe('BUY');
    expect(signal.symbol).toBe('INFY');
    expect(signal.entry).toBeGreaterThan(0);
    expect(signal.stopLoss).toBeLessThan(signal.entry);
    expect(signal.target).toBeGreaterThan(signal.entry);

    const entryRs = paiseToRupees(signal.entry);
    const slRs = paiseToRupees(signal.stopLoss);
    const targetRs = paiseToRupees(signal.target);

    // Stop distance should be ATR * 2.5
    const risk = entryRs - slRs;
    const reward = targetRs - entryRs;
    expect(risk).toBeGreaterThan(0);
    expect(reward).toBeGreaterThan(0);
    expect(reward / risk).toBeCloseTo(DEFAULT_SWING.targetRR, 1);
  });

  it('rejects flat non-trending markets', () => {
    const profile = new SwingProfile();
    const candles = synthesizeDailyCandles({ bars: 75, trend: 'flat' });
    const signal = profile.evaluate(makeCtx(candles));
    expect(signal).toBeNull();
  });
});

