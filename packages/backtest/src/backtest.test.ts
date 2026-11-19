import { describe, it, expect } from 'vitest';
import {
  newSignalId, rupeesToPaise, istMinutes, type Candle, type Signal,
} from '@tradeforger/core';
import {
  clampParams, getStrategy, type StrategyDefinition, type StrategyContext,
} from '@tradeforger/strategy';
import { roundTripCost, costBreakdown, EQUITY_INTRADAY, ZERO_COSTS } from './costs.ts';
import { runBacktest, DEFAULT_BACKTEST, type BacktestConfig, type TradeRecord } from './engine.ts';
import { computeMetrics } from './metrics.ts';
import { validateStrategy, perturbations } from './validate.ts';
import { dailySeries, intradaySeries, istMidnightOf } from './synthetic.ts';

// ───────────────────────────── test strategies ─────────────────────────────

const sig = (ctx: StrategyContext, side: 'BUY' | 'SELL', entry: number, stop: number, target: number): Signal => ({
  id: newSignalId(), instrumentKey: ctx.instrumentKey, symbol: ctx.symbol, style: 'SWING', side,
  entry: rupeesToPaise(entry), stopLoss: rupeesToPaise(stop), target: rupeesToPaise(target),
  atr: 1, confidence: 80, reasons: ['test'], indicators: {}, generatedAt: ctx.clock.ms(),
});

/** Daily: buy when the close breaks the prior bar's high. */
const BREAKOUT: StrategyDefinition = {
  id: 'TEST_BREAKOUT', name: 'test breakout', style: 'SWING', timeframe: '1d', description: 'test',
  defaults: { rr: 2, stopPct: 2 },
  bounds: { rr: { min: 1, max: 4, step: 0.5 }, stopPct: { min: 1, max: 5, step: 0.5 } },
  create(params) {
    const p = clampParams(BREAKOUT, params);
    return {
      style: 'SWING', name: 'test', warmupBars: 2,
      evaluate(ctx) {
        const c = ctx.candles;
        const last = c[c.length - 1];
        const prev = c[c.length - 2];
        if (!last || !prev || last.close <= prev.high) return null;
        const stop = last.close * (1 - p['stopPct']! / 100);
        return sig(ctx, 'BUY', last.close, stop, last.close + (last.close - stop) * p['rr']!);
      },
    };
  },
};

/** Daily: always signals the fixed levels it is given (for hand-built bars). */
const fixed = (stop: number, target: number, onlyAt?: number): StrategyDefinition => ({
  id: 'TEST_FIXED', name: 'fixed', style: 'SWING', timeframe: '1d', description: 'test',
  defaults: {}, bounds: {},
  create() {
    return {
      style: 'SWING', name: 'fixed', warmupBars: 1,
      evaluate(ctx) {
        if (onlyAt !== undefined && ctx.candles.length !== onlyAt) return null;
        const last = ctx.candles[ctx.candles.length - 1]!;
        return sig(ctx, 'BUY', last.close, stop, target);
      },
    };
  },
});

/** Intraday: buy at the 14:30 bar with very wide levels, so only EOD can close it. */
const LATE_BUY: StrategyDefinition = {
  id: 'TEST_LATE', name: 'late', style: 'INTRADAY', timeframe: '5m', description: 'test',
  defaults: {}, bounds: {},
  create() {
    return {
      style: 'INTRADAY', name: 'late', warmupBars: 1,
      evaluate(ctx) {
        const last = ctx.candles[ctx.candles.length - 1]!;
        if (istMinutes(new Date(last.ts)) !== 14 * 60 + 30) return null;
        return { ...sig(ctx, 'BUY', last.close, last.close * 0.5, last.close * 2), style: 'INTRADAY' };
      },
    };
  },
};

const day = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  ts: istMidnightOf('2026-01-05') + i * 86_400_000, open: o, high: h, low: l, close: c, volume: 1000,
});
const data = (candles: Candle[]) => ({ symbol: 'T', instrumentKey: 'NSE_EQ|T', candles });
const noFriction: BacktestConfig = { ...DEFAULT_BACKTEST, costs: ZERO_COSTS, slippageBps: 0 };

// ───────────────────────────── costs ─────────────────────────────

describe('cost model', () => {
  it('matches a hand-computed intraday round trip', () => {
    // BUY 100 @ 1000, SELL @ 1010.
    //  brokerage min(20, 0.05%×1,00,000=50)=20 + min(20, 50.5)=20 → 40
    //  STT 0.025% × 1,01,000 = 25.25 · exchange 0.00297% × 2,01,000 = 5.9697
    //  SEBI 0.0001% × 2,01,000 = 0.201 · stamp 0.003% × 1,00,000 = 3
    //  GST 18% × (40 + 5.9697 + 0.201) = 8.310726
    expect(roundTripCost(EQUITY_INTRADAY, 'BUY', 100, 1000, 1010)).toBeCloseTo(82.73, 2); // rounded to whole paise
    expect(costBreakdown(EQUITY_INTRADAY, 'BUY', 100, 1000, 1010).stt).toBeCloseTo(25.25, 6);
  });

  it('charges the sell-side STT on the exit leg of a long and the entry leg of a short', () => {
    const long = costBreakdown(EQUITY_INTRADAY, 'BUY', 10, 100, 200);
    const short = costBreakdown(EQUITY_INTRADAY, 'SELL', 10, 200, 100);
    expect(long.stt).toBeCloseTo(short.stt, 9);
  });
});

// ───────────────────────────── engine honesty ─────────────────────────────

describe('backtest engine', () => {
  it('fills at the NEXT bar open, with slippage against the trader', () => {
    const bars = [day(0, 100, 101, 99, 100), day(1, 102, 103, 101, 102), day(2, 102, 103, 101, 102)];
    const t = runBacktest(fixed(90, 130, 1), undefined, data(bars), { ...DEFAULT_BACKTEST, costs: ZERO_COSTS, slippageBps: 10 });
    expect(t[0]!.entryTs).toBe(bars[1]!.ts);
    expect(t[0]!.entryPrice).toBeCloseTo(102 * 1.001, 6);
  });

  it('skips a trade whose next open has already gapped through the stop', () => {
    const bars = [day(0, 100, 101, 99, 100), day(1, 85, 86, 84, 85), day(2, 85, 86, 84, 85)];
    expect(runBacktest(fixed(90, 130, 1), undefined, data(bars), noFriction)).toHaveLength(0);
  });

  it('assumes the stop came first when one bar touches both legs', () => {
    const bars = [day(0, 100, 101, 99, 100), day(1, 100, 101, 99, 100), day(2, 100, 140, 80, 100)];
    const t = runBacktest(fixed(90, 130, 1), undefined, data(bars), noFriction);
    expect(t[0]!.exitReason).toBe('STOPLOSS');
    expect(t[0]!.exitPrice).toBe(90);
  });

  it('fills a gapped stop at the worse open, and a target at the target exactly', () => {
    const gap = [day(0, 100, 101, 99, 100), day(1, 100, 101, 99, 100), day(2, 80, 81, 79, 80)];
    expect(runBacktest(fixed(90, 130, 1), undefined, data(gap), noFriction)[0]!.exitPrice).toBe(80);
    const win = [day(0, 100, 101, 99, 100), day(1, 100, 101, 99, 100), day(2, 125, 150, 124, 140)];
    const t = runBacktest(fixed(90, 130, 1), undefined, data(win), noFriction)[0]!;
    expect(t).toMatchObject({ exitReason: 'TARGET', exitPrice: 130 });
    expect(t.rMultiple).toBeCloseTo(3, 6); // (130-100)/(100-90)
  });

  it('cannot be changed by bars that had not happened yet (no lookahead)', () => {
    const all = dailySeries('2024-01-01', 300, { seed: 7, startPrice: 100, drift: 0.001, vol: 0.015 });
    const prefix = all.slice(0, 200);
    const cutoff = prefix[prefix.length - 1]!.ts;
    const done = (ts: TradeRecord[]) => ts.filter((t) => t.exitReason !== 'END_OF_DATA' && t.exitTs <= cutoff);
    expect(done(runBacktest(BREAKOUT, undefined, data(prefix))))
      .toEqual(done(runBacktest(BREAKOUT, undefined, data(all))));
  });

  it('flattens intraday positions at the 15:10 square-off', () => {
    const bars = intradaySeries('2026-01-05', 2, { seed: 3, startPrice: 500, drift: 0, vol: 0.001 });
    const t = runBacktest(LATE_BUY, undefined, data(bars), noFriction);
    expect(t.length).toBeGreaterThan(0);
    for (const tr of t) {
      expect(tr.exitReason).toBe('EOD');
      expect(istMinutes(new Date(tr.exitTs))).toBe(15 * 60 + 10);
    }
  });

  it('exits a swing trade on time after maxHoldBars', () => {
    const flat = Array.from({ length: 30 }, (_, i) => day(i, 100, 101, 99, 100));
    const t = runBacktest(fixed(80, 200, 1), undefined, data(flat), { ...noFriction, maxHoldBars: 5 });
    expect(t[0]).toMatchObject({ exitReason: 'TIME', barsHeld: 5 });
  });

  it('runs the real catalog strategies without throwing', () => {
    const intra = intradaySeries('2026-01-05', 15, { seed: 11, startPrice: 1000, drift: 0.0002, vol: 0.002, volume: 20_000 });
    const daily = dailySeries('2023-01-02', 400, { seed: 12, startPrice: 1000, drift: 0.0008, vol: 0.015 });
    for (const id of ['ORB_SUPERTREND', 'EMA_TREND_SWING']) {
      const def = getStrategy(id)!;
      expect(() => runBacktest(def, undefined, data(def.timeframe === '5m' ? intra : daily))).not.toThrow();
    }
  });

  it('replays 60 sessions of 5-minute bars quickly', () => {
    const bars = intradaySeries('2026-01-05', 60, { seed: 5, startPrice: 1000, drift: 0, vol: 0.002, volume: 20_000 });
    const t0 = performance.now();
    runBacktest(getStrategy('ORB_SUPERTREND')!, undefined, data(bars));
    expect(performance.now() - t0).toBeLessThan(5_000);
  });
});

// ───────────────────────────── metrics ─────────────────────────────

describe('metrics', () => {
  const tr = (netPnl: number, r: number, i: number): TradeRecord => ({
    strategyId: 'T', symbol: 'T', side: 'BUY', entryTs: i * 1000, entryPrice: 100, exitTs: i * 1000 + 500,
    exitPrice: 100, qty: 1, grossPnl: netPnl, costs: 0, netPnl, rMultiple: r, maeR: 0, mfeR: 0,
    exitReason: 'TARGET', barsHeld: 1,
  });

  it('computes PF, expectancy, win rate, streak and drawdown by hand', () => {
    const m = computeMetrics([tr(100, 1, 0), tr(-50, -0.5, 1), tr(200, 2, 2), tr(-50, -0.5, 3), tr(-50, -0.5, 4)], 100_000);
    expect(m.trades).toBe(5);
    expect(m.winRate).toBeCloseTo(0.4, 9);
    expect(m.profitFactor).toBeCloseTo(2, 9);       // 300 / 150
    expect(m.expectancyR).toBeCloseTo(0.3, 9);      // (1 - .5 + 2 - .5 - .5) / 5
    expect(m.longestLosingStreak).toBe(2);
    // Peak 1,00,250 → trough 1,00,150.
    expect(m.maxDrawdownPct).toBeCloseTo((100 / 100_250) * 100, 6);
  });

  it('is all zeros with no trades rather than NaN', () => {
    expect(Object.values(computeMetrics([], 100_000)).every((v) => v === 0)).toBe(true);
  });
});

// ───────────────────────────── validation gate ─────────────────────────────

describe('validation gate', () => {
  it('rejects a breakout strategy on a pure random walk', () => {
    const sets = [1, 2, 3].map((seed) => data(dailySeries('2020-01-01', 700, { seed, startPrice: 100, drift: 0, vol: 0.015 })));
    const r = validateStrategy(BREAKOUT, undefined, sets);
    expect(r.status).toBe('REJECTED');
    expect(r.checks.some((c) => !c.passed)).toBe(true);
  });

  it('approves a strategy with a planted, persistent edge', () => {
    // A strong steady trend: buying breakouts with a 2:1 target genuinely pays.
    const sets = [21, 22, 23].map((seed) => data(dailySeries('2020-01-01', 700, { seed, startPrice: 100, drift: 0.004, vol: 0.012 })));
    const r = validateStrategy(BREAKOUT, undefined, sets);
    expect(r.checks.filter((c) => !c.passed)).toEqual([]);
    expect(r.status).toBe('APPROVED');
    expect(r.full.trades).toBeGreaterThanOrEqual(30);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('reports every check, fold and perturbation', () => {
    const sets = [data(dailySeries('2020-01-01', 500, { seed: 9, startPrice: 100, drift: 0.002, vol: 0.012 }))];
    const r = validateStrategy(BREAKOUT, undefined, sets);
    expect(r.checks.map((c) => c.name)).toEqual(
      ['MIN_TRADES', 'IN_SAMPLE', 'OUT_OF_SAMPLE', 'WALK_FORWARD', 'PARAMETER_STABILITY', 'COST_STRESS']);
    expect(r.folds).toHaveLength(4);
    expect(r.sensitivity.length).toBe(perturbations(BREAKOUT, BREAKOUT.defaults, 20).length);
    expect(r.sensitivity.every((s) => s.param === 'rr' || s.param === 'stopPct')).toBe(true);
  });

  it('breaks performance down by market regime and names the losing ones', () => {
    const sets = [1, 2, 3].map((seed) => ({ ...data(dailySeries('2020-01-01', 700, { seed, startPrice: 100, drift: 0, vol: 0.015 })), symbol: `S${seed}` }));
    const r = validateStrategy(BREAKOUT, undefined, sets);
    expect(r.regimes.map((x) => x.regime)).toEqual(expect.arrayContaining(['HIGH_VOL', 'LOW_VOL']));
    const tagged = r.regimes.filter((x) => x.regime === 'HIGH_VOL' || x.regime === 'LOW_VOL').reduce((a, x) => a + x.metrics.trades, 0);
    expect(tagged).toBeLessThanOrEqual(r.full.trades);
    for (const w of r.weaknesses) expect(w).toMatch(/^(HIGH_VOL|LOW_VOL|UPTREND|DOWNTREND): \d+ trades at -/);
  });

  it('keeps perturbations inside the parameter bounds', () => {
    for (const p of perturbations(BREAKOUT, { rr: 4, stopPct: 1 }, 50)) {
      const b = BREAKOUT.bounds[p.param]!;
      expect(p.value).toBeGreaterThanOrEqual(b.min);
      expect(p.value).toBeLessThanOrEqual(b.max);
    }
  });
});
