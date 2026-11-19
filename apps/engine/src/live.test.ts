import { describe, it, expect } from 'vitest';
import { decide, mergeCandles, DEFAULT_AUTO, AutoConfigSchema, type AutoConfig, type Target } from './live.ts';

const setup = (over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] => ({
  instrumentKey: 'NSE_EQ|X', symbol: 'X', style: 'INTRADAY', side: 'BUY',
  entry: 100, stopLoss: 98, target: 104, rewardRisk: 2, quality: 80,
  primaryStrategyId: 'ORB_SUPERTREND', agreeing: [], conflicting: [], votes: [], reasons: [],
  generatedAt: 0, stableSince: 0, stableSeconds: 10, partialBar: true,
  ...over,
});
const equity: Target = { instrumentKey: 'NSE_EQ|X', symbol: 'X', fnoUnderlying: false, cashTradeable: true };
const index: Target = { instrumentKey: 'NSE_FO|1', symbol: 'NIFTY', fnoUnderlying: true, cashTradeable: false };
const on: AutoConfig = { ...DEFAULT_AUTO, enabled: true };
const paper = { mode: 'PAPER' as const, approved: () => false, entriesToday: 0 };

describe('autonomous entry decision', () => {
  it('acts on a stable, high-quality intraday setup in paper', () => {
    expect(decide(setup(), equity, on, paper)).toEqual({ route: 'EQ_INTRADAY', blockers: [] });
  });

  it('never acts when autonomous mode is off', () => {
    expect(decide(setup(), equity, DEFAULT_AUTO, paper).blockers).toContain('autonomous mode off');
  });

  it('applies the user quality and reward:risk floors', () => {
    const d = decide(setup({ quality: 60, rewardRisk: 1.1 }), equity, on, paper);
    expect(d.blockers).toEqual(expect.arrayContaining(['quality 60 < 70', 'R:R 1.10 < 1.5']));
  });

  it('waits for a setup to hold before trusting the forming bar', () => {
    expect(decide(setup({ stableSeconds: 2 }), equity, on, paper).blockers).toContain('stable 2s < 6s');
  });

  it('requires a human-approved strategy version in LIVE, not in PAPER', () => {
    const live = { ...paper, mode: 'LIVE' as const };
    expect(decide(setup(), equity, on, live).blockers.join()).toContain('APPROVED');
    expect(decide(setup(), equity, on, { ...live, approved: () => true }).blockers).toEqual([]);
  });

  it('routes index setups to F&O only when the F&O segment is on', () => {
    expect(decide(setup(), index, on, paper).blockers).toContain('F&O segment off');
    const fno = { ...on, segments: { ...on.segments, fno: true } };
    expect(decide(setup(), index, fno, paper)).toEqual({ route: 'FNO', blockers: [] });
  });

  it('routes swing setups to delivery only when swing is enabled', () => {
    expect(decide(setup({ style: 'SWING' }), equity, on, paper).blockers).toContain('swing segment off');
    const swing = { ...on, segments: { ...on.segments, swing: true } };
    expect(decide(setup({ style: 'SWING' }), equity, swing, paper).route).toBe('EQ_SWING');
  });

  it('honours the strategy allow-list and the daily entry cap', () => {
    const d = decide(setup(), equity, { ...on, strategies: ['VWAP_PULLBACK'] }, { ...paper, entriesToday: 5 });
    expect(d.blockers).toEqual(expect.arrayContaining(['ORB_SUPERTREND not enabled', 'daily entry cap 5 reached']));
  });

  it('rejects out-of-range user settings', () => {
    expect(AutoConfigSchema.safeParse({ ...DEFAULT_AUTO, minRewardRisk: 0.5 }).success).toBe(false);
    expect(AutoConfigSchema.safeParse({ ...DEFAULT_AUTO, confirmSeconds: 0 }).success).toBe(false);
  });
});

describe('candle merge', () => {
  const c = (ts: number, close: number) => ({ ts, open: close, high: close, low: close, close, volume: 1 });
  it('dedupes by timestamp, sorts, and lets the later source win', () => {
    const m = mergeCandles([c(2, 10), c(1, 9)], [c(2, 11), c(3, 12)]);
    expect(m.map((x) => x.close)).toEqual([9, 11, 12]);
  });
});
