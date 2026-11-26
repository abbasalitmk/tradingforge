import { describe, it, expect } from 'vitest';
import { FixedClock, type Candle, type Paise, paiseToRupees } from '@tradeforger/core';
import { IntradayProfile, DEFAULT_INTRADAY, trailStop } from './intraday.ts';
import { scoreConfluence } from './profile.ts';

/**
 * Synthesise a session: flat opening range, then a fresh breakout with rising volume.
 * 09:15 IST = 03:45 UTC.
 */
function session(opts: {
  bars: number;
  breakoutFrom?: number;
  direction?: 1 | -1;
  volumeMultiple?: number;
  stepPct?: number;
}): Candle[] {
  const { bars, breakoutFrom = Math.max(12, bars - 3), direction = 1, volumeMultiple = 3, stepPct = 0.0025 } = opts;
  const base = new Date('2026-09-14T03:45:00Z').getTime();
  const out: Candle[] = [];
  let price = 100;

  for (let i = 0; i < bars; i++) {
    const breaking = i >= breakoutFrom;
    if (breaking) {
      price += direction * (100 * stepPct);
    } else {
      // Two-way consolidation inside [99.4, 100.6] keeps RSI ~50 and ATR realistic before breakout.
      price = 100 + Math.sin(i * 0.9) * 0.35;
    }

    const nearEnd = i >= breakoutFrom;
    out.push({
      ts: base + i * 5 * 60_000,
      open: price - direction * 0.08,
      high: price + (breaking ? (direction === 1 ? 0.4 : 0.15) : 0.25),
      low: price - (breaking ? (direction === -1 ? 0.4 : 0.15) : 0.25),
      close: price,
      volume: nearEnd ? 1000 * volumeMultiple : 1000,
    });
  }
  return out;
}

/** 11:00 IST — inside the entry window. */
const clock = () => new FixedClock(new Date('2026-09-14T05:30:00Z'));

const ctx = (candles: Candle[], c = clock()) => ({
  instrumentKey: 'NSE_EQ|TEST',
  symbol: 'TEST',
  candles,
  higherTf: [],
  clock: c,
});

describe('warmup', () => {
  it('emits nothing before enough bars exist', () => {
    const p = new IntradayProfile();
    expect(p.evaluate(ctx(session({ bars: 10 })))).toBeNull();
  });
});

describe('session windows are enforced before any computation', () => {
  const candles = session({ bars: 60 });

  it.each([
    ['09:16 IST — before entry window', '2026-09-14T03:46:00Z'],
    ['14:46 IST — after entry window', '2026-09-14T09:16:00Z'],
    ['20:00 IST — market closed', '2026-09-14T14:30:00Z'],
  ])('refuses at %s', (_label, iso) => {
    const p = new IntradayProfile();
    expect(p.evaluate(ctx(candles, new FixedClock(new Date(iso))))).toBeNull();
  });
});

describe('opening range gating', () => {
  it('emits a long on a clean upside breakout with volume', () => {
    const p = new IntradayProfile();
    const s = p.evaluate(ctx(session({ bars: 60, direction: 1 })));
    expect(s).not.toBeNull();
    expect(s!.side).toBe('BUY');
  });

  it('emits a short on a downside breakout', () => {
    const p = new IntradayProfile();
    const s = p.evaluate(ctx(session({ bars: 60, direction: -1 })));
    expect(s).not.toBeNull();
    expect(s!.side).toBe('SELL');
  });

  it('emits nothing while price stays inside the range', () => {
    const p = new IntradayProfile();
    // breakoutFrom beyond the series → never leaves the range
    expect(p.evaluate(ctx(session({ bars: 60, breakoutFrom: 999 })))).toBeNull();
  });
});

describe('confluence requirements', () => {
  it('blocks stale breakouts, overbought RSI chases, and low-RVOL pokes as hard gates', () => {
    const p = new IntradayProfile();
    // Stale: 10+ bars past breakout (> freshBars = 5)
    expect(p.evaluate(ctx(session({ bars: 60, breakoutFrom: 48, stepPct: 0.0015 })))).toBeNull();
    // Low RVOL: volumeMultiple = 1 < 1.5
    expect(p.evaluate(ctx(session({ bars: 60, volumeMultiple: 1 })))).toBeNull();
    // Extreme exhaustion: rapid vertical climb pushes RSI > 72
    expect(p.evaluate(ctx(session({ bars: 60, breakoutFrom: 56, stepPct: 0.015 })))).toBeNull();
  });

  it('scores a higher-confidence breakout when indicators line up', () => {
    const base = new IntradayProfile({ ...DEFAULT_INTRADAY, minRelativeVolume: 0, minConfidence: 10 });
    const withRvol = new IntradayProfile({ ...DEFAULT_INTRADAY, minRelativeVolume: 1.5, minConfidence: 10 });
    expect(base.evaluate(ctx(session({ bars: 60, volumeMultiple: 1 })))).not.toBeNull();
    expect(withRvol.evaluate(ctx(session({ bars: 60, volumeMultiple: 1 })))).toBeNull();
    const strong = withRvol.evaluate(ctx(session({ bars: 60, volumeMultiple: 4 })))!;
    expect(strong.reasons.some((r) => r.startsWith('RVOL'))).toBe(true);
  });

  it('a higher confidence threshold produces fewer signals', () => {
    const candles = session({ bars: 60 });
    const lax = new IntradayProfile({ ...DEFAULT_INTRADAY, minConfidence: 10 });
    const strict = new IntradayProfile({ ...DEFAULT_INTRADAY, minConfidence: 99 });
    expect(lax.evaluate(ctx(candles))).not.toBeNull();
    expect(strict.evaluate(ctx(candles))).toBeNull();
  });

  it('requires hard Supertrend, VWAP, ADX and close-location gates when hardGates is enabled', () => {
    const p = new IntradayProfile(
      { ...DEFAULT_INTRADAY, minAdx: 25, minConfidence: 10 },
      { hardGates: true, minStopPct: 0.75 },
    );
    // Sideways chop (ADX below 25) or soft low-RVOL breakout cannot bypass hardGates even at minConfidence: 10.
    expect(p.evaluate(ctx(session({ bars: 60, breakoutFrom: 57, stepPct: 0.0005 })))).toBeNull();
  });

  it('records which checks fired, so a trade can be explained later', () => {
    const s = new IntradayProfile().evaluate(ctx(session({ bars: 60 })))!;
    expect(s.reasons.length).toBeGreaterThan(0);
    expect(s.reasons.some((r) => r.startsWith('ORB'))).toBe(true);
  });
});

describe('risk geometry', () => {
  it('places the stop an ATR multiple away and the target at the configured R:R', () => {
    const p = new IntradayProfile({ ...DEFAULT_INTRADAY, stopAtrMultiple: 1.5, targetRR: 2 });
    const s = p.evaluate(ctx(session({ bars: 60 })))!;

    const risk = Math.abs(paiseToRupees(s.entry) - paiseToRupees(s.stopLoss));
    const reward = Math.abs(paiseToRupees(s.target) - paiseToRupees(s.entry));
    expect(risk).toBeCloseTo(s.atr * 1.5, 1);
    expect(reward / risk).toBeCloseTo(2, 1);
  });

  it('orders stop below and target above for a long', () => {
    const s = new IntradayProfile().evaluate(ctx(session({ bars: 60, direction: 1 })))!;
    expect(s.stopLoss).toBeLessThan(s.entry);
    expect(s.target).toBeGreaterThan(s.entry);
  });

  it('inverts the geometry for a short', () => {
    const s = new IntradayProfile().evaluate(ctx(session({ bars: 60, direction: -1 })))!;
    expect(s.stopLoss).toBeGreaterThan(s.entry);
    expect(s.target).toBeLessThan(s.entry);
  });
});

describe('determinism', () => {
  it('identical input produces an identical decision', () => {
    const candles = session({ bars: 60 });
    const p = new IntradayProfile();
    const a = p.evaluate(ctx(candles))!;
    const b = p.evaluate(ctx(candles))!;
    // Ignore the ULID, which is time-seeded by design.
    const strip = (s: typeof a) => ({ ...s, id: '', generatedAt: 0 });
    expect(strip(a)).toEqual(strip(b));
  });
});

describe('trailing stop only tightens', () => {
  const P = (r: number) => Math.round(r * 100) as Paise;

  it('raises a long stop as price advances', () => {
    expect(trailStop('BUY', P(95), P(110), 2, 1.5)).toBe(P(107));
  });

  it('never lowers a long stop when price falls back', () => {
    expect(trailStop('BUY', P(107), P(100), 2, 1.5)).toBe(P(107));
  });

  it('lowers a short stop as price falls', () => {
    expect(trailStop('SELL', P(105), P(90), 2, 1.5)).toBe(P(93));
  });

  it('never raises a short stop when price rebounds', () => {
    expect(trailStop('SELL', P(93), P(100), 2, 1.5)).toBe(P(93));
  });
});

describe('confluence scoring', () => {
  it('is the fraction of achievable weight that fired', () => {
    expect(scoreConfluence([
      { name: 'a', passed: true, weight: 3, detail: '' },
      { name: 'b', passed: false, weight: 1, detail: '' },
    ])).toBe(75);
  });
  it('handles the empty case without dividing by zero', () => {
    expect(scoreConfluence([])).toBe(0);
  });
});
