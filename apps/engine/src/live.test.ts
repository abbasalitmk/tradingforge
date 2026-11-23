import { describe, it, expect } from 'vitest';
import {
  decide, canLead, mergeCandles, segmentsForMode, modeForSegments, repriceToMarket, DEFAULT_AUTO, AutoConfigSchema, type AutoConfig, type Target,
} from './live.ts';

const upBias = { side: 'BUY' as const, vwapSide: 'BUY' as const, emaSide: 'BUY' as const, close: 101, vwap: 100, ema20: 100.5, ema50: 99, adx: 28, reason: '15-min up' };
const downBias = { ...upBias, side: 'SELL' as const, vwapSide: 'SELL' as const, emaSide: 'SELL' as const, close: 99, reason: '15-min down' };
const setup = (over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] => ({
  instrumentKey: 'NSE_EQ|X', symbol: 'X', style: 'INTRADAY', side: 'BUY',
  entry: 100, stopLoss: 98, target: 104, rewardRisk: 2, quality: 80,
  primaryStrategyId: 'ORB_SUPERTREND', agreeing: [], conflicting: [], votes: [], reasons: [],
  generatedAt: 0, stableSince: 0, stableSeconds: 10, partialBar: true, invalidReason: null, bias: upBias,
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

  it('blocks entries when setup price is outside minPrice and maxPrice filters', () => {
    const priceFiltered = { ...on, minPrice: 200, maxPrice: 500 };
    // setup has entry = 100, which is < minPrice 200
    expect(decide(setup(), equity, priceFiltered, paper).blockers).toContain('price ₹100.00 < min ₹200');
    // setup with entry = 600 > maxPrice 500
    expect(decide(setup({ entry: 600 }), equity, priceFiltered, paper).blockers).toContain('price ₹600.00 > max ₹500');
    // setup with entry = 300 within range
    expect(decide(setup({ entry: 300 }), equity, priceFiltered, paper).blockers).toEqual([]);
  });

  it('maps the dashboard strategy mode onto the segments decide() reads', () => {
    const swingOnly = { ...on, segments: segmentsForMode('SWING', on.segments) };
    expect(decide(setup(), equity, swingOnly, paper).blockers).toContain('intraday segment off');
    expect(decide(setup({ style: 'SWING' }), equity, swingOnly, paper).route).toBe('EQ_SWING');

    const both = segmentsForMode('BOTH', { intraday: false, swing: false, fno: true });
    expect(both).toEqual({ intraday: true, swing: true, fno: true });
    expect(modeForSegments(segmentsForMode('INTRADAY', both))).toBe('INTRADAY');
    expect(modeForSegments({ intraday: false, swing: false, fno: true })).toBeNull();
  });

  it('trades only the direction the filter allows: buy by default, short or both on request', () => {
    expect(decide(setup({ side: 'SELL', bias: downBias }), equity, on, paper).blockers).toContain('direction filter is buy only');
    expect(decide(setup({ side: 'SELL', bias: downBias }), equity, { ...on, tradeSide: 'BOTH' }, paper).blockers).toEqual([]);
    expect(decide(setup({ side: 'SELL', bias: downBias }), equity, { ...on, tradeSide: 'SELL' }, paper).blockers).toEqual([]);
    expect(decide(setup(), equity, { ...on, tradeSide: 'SELL' }, paper).blockers).toContain('direction filter is short only');
  });

  it('never automates a swing SELL, even with shorting allowed', () => {
    const swing = { ...on, tradeSide: 'BOTH' as const, segments: { ...on.segments, swing: true } };
    expect(decide(setup({ style: 'SWING', side: 'SELL' }), equity, swing, paper).blockers.join()).toContain('delivery holdings');
  });

  it('applies the direction filter to the F&O view', () => {
    const fno = { ...on, segments: { ...on.segments, fno: true } };
    expect(decide(setup({ side: 'SELL', bias: downBias }), index, fno, paper).blockers).toContain('direction filter is buy only');
    expect(decide(setup({ side: 'SELL', bias: downBias }), index, { ...fno, tradeSide: 'BOTH' }, paper).blockers).toEqual([]);
  });

  it('lets only a tradeable vote lead', () => {
    const vote = (strategyId: string, side: 'BUY' | 'SELL') =>
      ({ strategyId, name: strategyId, style: 'INTRADAY' as const, side, confidence: 80, signal: null, reasons: [] });
    expect(canLead(vote('VWAP_PULLBACK', 'BUY'), equity, on, paper, upBias)).toBe(true);
    expect(canLead(vote('VWAP_PULLBACK', 'SELL'), equity, on, paper, downBias)).toBe(false);
    expect(canLead(vote('VWAP_PULLBACK', 'SELL'), equity, { ...on, tradeSide: 'SELL' }, paper, downBias)).toBe(true);
    expect(canLead(vote('VWAP_PULLBACK', 'BUY'), equity, { ...on, tradeSide: 'SELL' }, paper, upBias)).toBe(false);
    const live = { ...paper, mode: 'LIVE' as const, approved: (id: string) => id === 'ORB_SUPERTREND' };
    expect(canLead(vote('VWAP_PULLBACK', 'BUY'), equity, on, live, upBias)).toBe(false);
    expect(canLead(vote('ORB_SUPERTREND', 'BUY'), equity, on, live, upBias)).toBe(true);
    // A vote against the 15-minute trend cannot lead; neither can any without one.
    expect(canLead(vote('VWAP_PULLBACK', 'BUY'), equity, on, paper, downBias)).toBe(false);
    expect(canLead(vote('VWAP_PULLBACK', 'BUY'), equity, on, paper, null)).toBe(false);
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

describe('swing setups re-priced to the live market', () => {
  const swing = {
    instrumentKey: 'NSE_EQ|X', symbol: 'X', style: 'SWING' as const, side: 'BUY' as const,
    entry: 100, stopLoss: 95, target: 110, rewardRisk: 2, quality: 80, primaryStrategyId: 'EMA_TREND_SWING',
    agreeing: [], conflicting: [],
    votes: [{ strategyId: 'EMA_TREND_SWING', name: 'EMA', style: 'SWING' as const, side: 'BUY' as const, confidence: 80, reasons: [],
      signal: { entry: 10_000, stopLoss: 9_500, target: 11_000 } as never }],
    reasons: [], generatedAt: 0,
  };

  it('moves entry to the LTP, keeps the levels, and recomputes R:R', () => {
    const { setup: s, invalid } = repriceToMarket(swing, 102);
    expect(invalid).toBeNull();
    expect(s.entry).toBe(102);
    expect([s.stopLoss, s.target]).toEqual([95, 110]);
    expect(s.rewardRisk).toBeCloseTo(8 / 7, 2);
    expect((s.votes[0]!.signal as { entry: number }).entry).toBe(10_200);
  });

  it('invalidates a setup the market has already played out', () => {
    expect(repriceToMarket(swing, 94).invalid).toContain('through stop');
    expect(repriceToMarket(swing, 111).invalid).toContain('past target');
  });

  it('a gap toward the target is caught by the R:R floor in decide()', () => {
    const { setup: s } = repriceToMarket(swing, 108);
    const d = decide({ ...s, stableSince: 0, stableSeconds: 60, partialBar: false, invalidReason: null, bias: null }, equity,
      { ...on, segments: { ...on.segments, swing: true } }, paper);
    expect(d.blockers.join()).toContain('R:R');
  });
});

describe('portfolio limits and strategy gating', () => {
  const open = (total: number, byStrategy: Record<string, number> = {}, bySide = { BUY: 0, SELL: 0 }) => ({ total, byStrategy, bySide });

  it('caps open positions in total, per lead strategy and per side', () => {
    const d = decide(setup(), equity, on, { ...paper, open: open(5, { ORB_SUPERTREND: 2 }, { BUY: 3, SELL: 0 }) });
    expect(d.blockers).toEqual(expect.arrayContaining([
      '5 positions open (max 5)', '2 open from ORB_SUPERTREND (max 2)', '3 long positions open (max 3)',
    ]));
    // A short is a different bet from the open longs.
    expect(decide(setup({ side: 'SELL', bias: downBias }), equity, { ...on, tradeSide: 'BOTH' }, { ...paper, open: open(3, {}, { BUY: 3, SELL: 0 }) }).blockers).toEqual([]);
  });

  it('pauses a strategy only once its own record is meaningful and losing', () => {
    const losing = { ...paper, record: () => ({ trades: 25, expectancyR: -0.12 }) };
    expect(decide(setup(), equity, on, losing).blockers.join()).toContain('ORB_SUPERTREND paused');
    expect(decide(setup(), equity, on, { ...paper, record: () => ({ trades: 8, expectancyR: -0.9 }) }).blockers).toEqual([]);
    expect(decide(setup(), equity, { ...on, pauseLosingStrategies: false }, losing).blockers).toEqual([]);
  });

  it('gives configs saved before these limits existed the safe defaults', () => {
    const {
      maxOpenPositions: _a, maxPerStrategy: _b, maxSameSide: _c, trailStop: _d, pauseLosingStrategies: _e,
      minNetRewardRisk: _f, skipFailedStrategies: _g, ...old
    } = DEFAULT_AUTO;
    const parsed = AutoConfigSchema.parse(old);
    expect([parsed.maxOpenPositions, parsed.maxPerStrategy, parsed.maxSameSide, parsed.trailStop, parsed.pauseLosingStrategies, parsed.minNetRewardRisk, parsed.skipFailedStrategies])
      .toEqual([5, 2, 3, false, true, 1.25, true]);
    // A config saved before the direction filter existed trades buy only after the upgrade.
    const { tradeSide: _h, autoUniverse: _i, autoUniverseSize: _j, autoUniverseMinTurnoverCr: _k, ...older } = DEFAULT_AUTO;
    expect(AutoConfigSchema.parse(older)).toMatchObject({ tradeSide: 'BUY', autoUniverse: true, autoUniverseSize: 15 });
  });

  it('keeps a strategy that failed validation from leading entries, in paper too', () => {
    const failed = { ...paper, verdict: () => ({ status: 'REJECTED' as const, oosExpectancyR: -0.37 }) };
    expect(decide(setup(), equity, on, failed).blockers.join()).toContain('ORB_SUPERTREND failed validation (-0.37R out-of-sample)');
    expect(decide(setup(), equity, { ...on, skipFailedStrategies: false }, failed).blockers).toEqual([]);
    // Never validated is not the same as failed: paper is where it earns a record.
    expect(decide(setup(), equity, on, { ...paper, verdict: () => null }).blockers).toEqual([]);
    expect(decide(setup(), equity, on, { ...paper, verdict: () => ({ status: 'VALIDATED' as const, oosExpectancyR: 0.2 }) }).blockers).toEqual([]);
  });
});

describe('session discipline', () => {
  it('takes intraday entries only with the 15-minute trend', () => {
    expect(decide(setup({ side: 'SELL', stopLoss: 102, target: 96 }), equity, { ...on, tradeSide: 'BOTH' }, paper).blockers.join())
      .toContain('against a 15-min trend');
    expect(decide(setup({ bias: { ...upBias, side: null, reason: '15-min ADX 12 < 20 — no trend' } }), equity, { ...on, htfBiasStrict: true }, paper).blockers.join())
      .toContain('no trend');
    expect(decide(setup({ bias: null }), equity, on, paper).blockers).toContain('15-min bias unavailable');
    expect(decide(setup({ bias: null }), equity, { ...on, htfBias: false }, paper).blockers).toEqual([]);
  });

  it('lets a counter-trend strategy fade a flat 15-minute tape, never a trend against it', () => {
    const fade = setup({ primaryStrategyId: 'BB_RSI_REVERSION' });
    const flat = { ...upBias, side: null, reason: '15-min ADX 12 < 20 — no trend' };
    expect(decide({ ...fade, bias: flat }, equity, on, paper).blockers).toEqual([]);
    expect(decide({ ...fade, bias: null }, equity, on, paper).blockers).toEqual([]);
    expect(decide({ ...fade, bias: downBias }, equity, on, paper).blockers.join()).toContain('fade against a 15-min trend');
    // A trend strategy still needs the trend with it.
    expect(decide(setup({ bias: flat }), equity, { ...on, htfBiasStrict: true }, paper).blockers.join()).toContain('no trend');
  });

  it('by default needs price on the right side of 15-min VWAP and no full trend against (23 Nov trades)', () => {
    // PNB: bought into a full 15-min downtrend — blocked.
    expect(decide(setup({ bias: downBias }), equity, on, paper).blockers.join()).toContain('against a 15-min trend');
    // KARURVYSYA: above VWAP, EMAs not yet crossed up — traded (+1.86R).
    const early = { ...upBias, side: null, emaSide: 'SELL' as const, reason: '15-min mixed' };
    expect(decide(setup({ bias: early }), equity, on, paper).blockers).toEqual([]);
    // ...but strict mode wants the EMAs and ADX too.
    expect(decide(setup({ bias: early }), equity, { ...on, htfBiasStrict: true }, paper).blockers.join()).toContain('against 15-min bias');
    // Below VWAP with EMAs still up: a long has nothing under it.
    const under = { ...upBias, side: null, vwapSide: 'SELL' as const, reason: '15-min mixed' };
    expect(decide(setup({ bias: under }), equity, on, paper).blockers.join()).toContain('wrong side of 15-min VWAP');
    // An index has no VWAP; the EMAs decide.
    expect(decide(setup({ bias: { ...upBias, side: null, vwapSide: null, vwap: null } }), equity, on, paper).blockers).toEqual([]);
  });

  it('caps entries per session inside the daily cap', () => {
    const ctx = { ...paper, entriesToday: 5, session: 'AFTERNOON' as const, entriesBySession: { MORNING: 5, AFTERNOON: 3 } };
    const d = decide(setup(), equity, { ...on, maxEntriesPerDay: 8 }, ctx);
    expect(d.blockers).toEqual(['afternoon entry cap 3 reached']);
    expect(decide(setup(), equity, { ...on, maxEntriesPerDay: 8 }, { ...ctx, entriesBySession: { MORNING: 5, AFTERNOON: 2 } }).blockers).toEqual([]);
  });

  it('waits out the re-entry cooldown after a position in the symbol closes', () => {
    const d = decide(setup(), equity, on, { ...paper, reentryWaitSec: (sym) => (sym === 'X' ? 120 : 0) });
    expect(d.blockers.join()).toContain('re-entry cooldown');
  });

  it('caps open positions per sector', () => {
    const banked: Target = { ...equity, sector: 'Financial Services' };
    const open = { total: 2, byStrategy: {}, bySide: { BUY: 2, SELL: 0 }, bySector: { 'Financial Services': 2 } };
    expect(decide(setup(), banked, on, { ...paper, open }).blockers.join()).toContain('per sector');
    expect(decide(setup(), { ...banked, sector: 'Power' }, on, { ...paper, open }).blockers).toEqual([]);
    expect(decide(setup(), equity, on, { ...paper, open }).blockers).toEqual([]);
  });
});
