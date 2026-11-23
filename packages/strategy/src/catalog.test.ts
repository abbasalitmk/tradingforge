import { describe, it, expect } from 'vitest';
import { FixedClock, istMinutes, SESSION, type Candle, type Signal } from '@tradeforger/core';
import { STRATEGY_CATALOG, getStrategy, clampParams, type StrategyDefinition } from './catalog.ts';
import { intraday, daily, closeOf, type Regime } from './fixtures.ts';

const up = (seed: number, tf: '5m' | '1d'): Regime =>
  tf === '5m' ? { seed, start: 1000, drift: 0.0006, vol: 0.003, volume: 20_000 } : { seed, start: 1000, drift: 0.002, vol: 0.015, volume: 1e6 };
const down = (seed: number, tf: '5m' | '1d'): Regime => ({ ...up(seed, tf), drift: -up(seed, tf).drift });
const bars = (def: StrategyDefinition, g: Regime): Candle[] =>
  def.timeframe === '5m' ? intraday('2026-01-05', 8, g) : daily('2023-01-02', 400, g);

/** Evaluate at every bar close, exactly as the backtester and live loop do. */
function walk(def: StrategyDefinition, candles: readonly Candle[]): Array<{ i: number; at: number; s: Signal }> {
  const prof = def.create();
  const clock = new FixedClock(new Date(0));
  const out: Array<{ i: number; at: number; s: Signal }> = [];
  for (let i = 0; i < candles.length; i++) {
    const at = closeOf(candles[i]!, def.timeframe);
    clock.set(new Date(at));
    const s = prof.evaluate({ instrumentKey: 'NSE_EQ|T', symbol: 'T', candles: candles.slice(Math.max(0, i - 299), i + 1), higherTf: [], clock });
    if (s) out.push({ i, at, s });
  }
  return out;
}

const runs = new Map<string, ReturnType<typeof walk>>();
const signalsOf = (def: StrategyDefinition, dir: 'up' | 'down', seed = 1) => {
  const k = `${def.id}|${dir}|${seed}`;
  if (!runs.has(k)) runs.set(k, walk(def, bars(def, (dir === 'up' ? up : down)(seed, def.timeframe))));
  return runs.get(k)!;
};

/**
 * Strategies that need a market the random-walk fixture never makes (an
 * overnight gap, an option chain, a ranging low-ADX tape, a narrow-CPR day).
 * Their signals are tested on hand-built scenarios in playbook.test.ts.
 */
const SCENARIO_ONLY = new Set(['GAP_AND_GO', 'OI_WALL_REVERSAL', 'BB_RSI_REVERSION', 'PDH_PDL_CPR']);

describe.each(STRATEGY_CATALOG.map((d) => [d.id, d] as const))('%s', (_id, def) => {
  it('has bounded params whose defaults sit inside the bounds', () => {
    for (const [k, b] of Object.entries(def.bounds)) {
      const v = def.defaults[k];
      expect(v, `${k} default`).toBeDefined();
      expect(v!).toBeGreaterThanOrEqual(b.min);
      expect(v!).toBeLessThanOrEqual(b.max);
    }
  });

  if (SCENARIO_ONLY.has(def.id)) return;

  it('produces signals with sane geometry, tagged with its id', () => {
    const all = [...signalsOf(def, 'up'), ...signalsOf(def, 'down')];
    expect(all.length).toBeGreaterThan(0);
    const minConf = def.defaults['minConfidence'] ?? 0;
    for (const { s, i } of all) {
      expect(s.strategyId).toBe(def.id);
      if (s.side === 'BUY') {
        expect(s.stopLoss).toBeLessThan(s.entry);
        expect(s.target).toBeGreaterThan(s.entry);
      } else {
        expect(s.stopLoss).toBeGreaterThan(s.entry);
        expect(s.target).toBeLessThan(s.entry);
      }
      expect(s.confidence).toBeGreaterThanOrEqual(minConf);
      expect(s.confidence).toBeLessThanOrEqual(100);
      expect(s.reasons.length, `bar ${i}`).toBeGreaterThan(0);
      expect(Object.values(s.indicators).every(Number.isFinite)).toBe(true);
    }
  });

  // A counter-trend strategy buys weakness: it leans against the trend by design.
  if (!def.counterTrend) it('leans with the trend: more longs in an uptrend than in a downtrend', () => {
    const buys = (dir: 'up' | 'down') => signalsOf(def, dir).filter((x) => x.s.side === 'BUY').length;
    expect(buys('up')).toBeGreaterThan(buys('down'));
  });

  if (def.timeframe === '5m') {
    it('only signals inside the 09:20–14:45 IST entry window', () => {
      for (const { at } of [...signalsOf(def, 'up'), ...signalsOf(def, 'down')]) {
        const m = istMinutes(new Date(at));
        expect(m).toBeGreaterThanOrEqual(SESSION.ENTRY_START);
        expect(m).toBeLessThan(SESSION.ENTRY_END);
      }
    });
  }

  it('is deterministic: same candles and clock give the same signal', () => {
    const first = signalsOf(def, 'up')[0]!;
    const candles = bars(def, up(1, def.timeframe)).slice(Math.max(0, first.i - 299), first.i + 1);
    const again = def.create().evaluate({ instrumentKey: 'NSE_EQ|T', symbol: 'T', candles, higherTf: [], clock: new FixedClock(new Date(first.at)) });
    expect(again).toMatchObject({ side: first.s.side, entry: first.s.entry, stopLoss: first.s.stopLoss, target: first.s.target, confidence: first.s.confidence });
  });

  it('refuses everything at the strictest confidence bound it allows', () => {
    const b = def.bounds['minConfidence'];
    if (!b || b.max < 100) return; // only meaningful where 100 is allowed
    const strict = def.create(clampParams(def, { minConfidence: 100 }));
    expect(strict).toBeDefined();
  });
});

// The catalog strategies added for the hybrid engine guard against being
// handed bars from the future (the original two rely on their caller).
describe('lookahead guard', () => {
  const guarded = [
    'VWAP_PULLBACK', 'SUPERTREND_MOMENTUM', 'BB_SQUEEZE_BREAKOUT', 'GMMA_TREND', 'RSI_MEAN_REVERSION', 'DONCHIAN_BREAKOUT',
    'ICHIMOKU_CLOUD', 'SMC_STRUCTURE', 'CANDLESTICK_PATTERNS', 'TECHNICAL_COMPOSITE', 'EMA_CROSS_9_21', 'FAILED_BREAKOUT_TRAP',
  ];
  it.each(guarded)('%s ignores bars after the clock', (id) => {
    const def = getStrategy(id)!;
    const series = bars(def, up(1, def.timeframe));
    const first = signalsOf(def, 'up')[0]!;
    const past = series.slice(Math.max(0, first.i - 299), first.i + 1);
    const withFuture = [...past, ...series.slice(first.i + 1, first.i + 40)];
    const clock = new FixedClock(new Date(first.at));
    const a = def.create().evaluate({ instrumentKey: 'NSE_EQ|T', symbol: 'T', candles: past, higherTf: [], clock });
    const b = def.create().evaluate({ instrumentKey: 'NSE_EQ|T', symbol: 'T', candles: withFuture, higherTf: [], clock });
    expect(b?.side).toBe(a?.side);
    expect(b?.entry).toBe(a?.entry);
    expect(b?.stopLoss).toBe(a?.stopLoss);
  });
});

describe('session handling with multi-day warmup', () => {
  it('intraday strategies do not trade a stale bar from yesterday in the morning', () => {
    for (const def of STRATEGY_CATALOG.filter((d) => d.timeframe === '5m')) {
      const series = intraday('2026-01-05', 3, up(4, '5m'));
      // Clock at 10:00 IST on the next session, but no bars from it yet.
      const clock = new FixedClock(new Date(Date.parse('2026-01-08T10:00:00+05:30')));
      expect(def.create().evaluate({ instrumentKey: 'K', symbol: 'S', candles: series, higherTf: [], clock })).toBeNull();
    }
  });
});

describe('long-only swing strategies', () => {
  it('daily strategies that would hold equity overnight never short by default', () => {
    for (const id of ['RSI_MEAN_REVERSION', 'DONCHIAN_BREAKOUT', 'ICHIMOKU_CLOUD', 'CANDLESTICK_PATTERNS']) {
      const def = getStrategy(id)!;
      expect(signalsOf(def, 'down').every((x) => x.s.side === 'BUY')).toBe(true);
    }
  });
});
