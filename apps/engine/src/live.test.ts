import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise, type SignalId } from '@tradeforger/core';
import { getStrategy } from '@tradeforger/strategy';
import { intraday, closeOf } from '../../../packages/strategy/src/fixtures.ts';
import {
  decide, canLead, signalAgeMs, guardSetupStop, restateTarget, mergeCandles, segmentsForMode, modeForSegments, repriceToMarket,
  staleInstruments, chaseBlocker, DEFAULT_AUTO, AutoConfigSchema, type AutoConfig, type Target,
} from './live.ts';

const upBias = { side: 'BUY' as const, vwapSide: 'BUY' as const, emaSide: 'BUY' as const, close: 101, vwap: 100, ema20: 100.5, ema50: 99, adx: 28, reason: '15-min up' };
const downBias = { ...upBias, side: 'SELL' as const, vwapSide: 'SELL' as const, emaSide: 'SELL' as const, close: 99, reason: '15-min down' };
const setup = (over: Partial<Parameters<typeof decide>[0]> = {}): Parameters<typeof decide>[0] => ({
  instrumentKey: 'NSE_EQ|X', symbol: 'X', style: 'INTRADAY', side: 'BUY',
  entry: 100, stopLoss: 98, target: 104, rewardRisk: 2, quality: 80,
  primaryStrategyId: 'ORB_SUPERTREND', agreeing: [], conflicting: [], votes: [], reasons: [],
  generatedAt: 0, stableSince: 0, stableSeconds: 10, partialBar: true, invalidReason: null, bias: upBias,
  // The market with the trade and the stock leading it, unless a test says otherwise.
  marketSide: over.side ?? 'BUY', relStrengthPct: (over.side ?? 'BUY') === 'BUY' ? 1 : -1,
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

  it('refuses to chase a move already far from VWAP (PFOCUS, 23 Nov), not one still near it', () => {
    const short = (stretch: number) => setup({ side: 'SELL', bias: downBias, vwapStretchAtr: stretch });
    const both = { ...on, tradeSide: 'BOTH' as const };
    // PFOCUS: shorted 7.7 ATR under VWAP — stopped out.
    expect(decide(short(-7.7), equity, both, paper).blockers.join()).toContain('chases a move 7.7 ATR from VWAP');
    // RATNAVEER: bought 4.2 ATR over VWAP — inside the limit, hit its target.
    expect(decide(setup({ vwapStretchAtr: 4.2 }), equity, on, paper).blockers).toEqual([]);
    // Stretched the other way is not a chase; a fade strategy is exempt; 0 turns it off.
    expect(decide(setup({ vwapStretchAtr: -7 }), equity, on, paper).blockers).toEqual([]);
    expect(decide(setup({ vwapStretchAtr: 9, primaryStrategyId: 'BB_RSI_REVERSION' }), equity, on, paper).blockers).toEqual([]);
    expect(decide(short(-7.7), equity, { ...both, maxVwapStretchAtr: 0 }, paper).blockers).toEqual([]);
  });

  it('counts the time since the signal bar closed when a setup is first seen mid-bar', () => {
    const def = getStrategy('ORB_SUPERTREND')!;
    const bars = intraday('2026-01-05', 8, { seed: 1, start: 1000, drift: 0.0006, vol: 0.003, volume: 20_000 });
    const fires = (i: number) => def.create().evaluate({
      instrumentKey: 'K', symbol: 'S', candles: bars.slice(0, i + 1), higherTf: [], clock: new FixedClock(new Date(closeOf(bars[i]!, '5m'))),
    });
    // A bar that fired when the one before it did not: a brand-new signal.
    const i = bars.findIndex((_, k) => k > 1 && fires(k)?.side === 'BUY' && fires(k - 1)?.side !== 'BUY');
    expect(i).toBeGreaterThan(0);
    const closedAt = closeOf(bars[i]!, '5m');
    const ctx = { instrumentKey: 'K', symbol: 'S' };
    expect(signalAgeMs('ORB_SUPERTREND', 'BUY', bars.slice(0, i + 1), [], undefined, 3, ctx, closedAt)).toBe(0);
    // First seen 4 minutes after that bar closed (a restart, a new pick): 4 minutes old, not new.
    expect(signalAgeMs('ORB_SUPERTREND', 'BUY', bars.slice(0, i + 1), [], undefined, 3, ctx, closedAt + 4 * 60_000)).toBe(4 * 60_000);
  });

  it('skips a setup that went stale waiting for a slot, and enters a fresh one', () => {
    // 23 Nov: every close was followed by an entry within seconds — setups that
    // had stood behind the position cap for an hour.
    expect(decide(setup({ stableSeconds: 3600 }), equity, on, paper).blockers.join()).toContain('stale: signalling for 60 min');
    expect(decide(setup({ stableSeconds: 300 }), equity, on, paper).blockers).toEqual([]);
    expect(decide(setup({ stableSeconds: 3600 }), equity, { ...on, maxSetupAgeMin: 0 }, paper).blockers).toEqual([]);
  });

  it('measures how long a signal has stood from earlier closed bars, on first sight', () => {
    const def = getStrategy('ORB_SUPERTREND')!;
    const bars = intraday('2026-01-05', 8, { seed: 1, start: 1000, drift: 0.0006, vol: 0.003, volume: 20_000 });
    const fires = (i: number) => def.create().evaluate({
      instrumentKey: 'K', symbol: 'S', candles: bars.slice(0, i + 1), higherTf: [], clock: new FixedClock(new Date(closeOf(bars[i]!, '5m'))),
    });
    // A bar where ORB fired on this bar and the two before it.
    const i = bars.findIndex((_, k) => k > 2 && [k, k - 1, k - 2].every((j) => fires(j)?.side === 'BUY'));
    expect(i).toBeGreaterThan(0);
    const age = signalAgeMs('ORB_SUPERTREND', 'BUY', bars.slice(0, i + 1), [], undefined, 5, { instrumentKey: 'K', symbol: 'S' });
    expect(age).toBeGreaterThanOrEqual(2 * 5 * 60_000);
    expect(signalAgeMs('ORB_SUPERTREND', 'SELL', bars.slice(0, i + 1), [], undefined, 5, { instrumentKey: 'K', symbol: 'S' })).toBe(0);
  });

  it('needs an intraday stop wide enough that charges do not eat the edge', () => {
    expect(decide(setup({ entry: 264.25, stopLoss: 265.1, side: 'SELL', target: 262.55, bias: downBias }), equity, { ...on, tradeSide: 'BOTH' }, paper).blockers.join())
      .toContain('stop 0.32% from entry');
    expect(decide(setup(), equity, on, paper).blockers).toEqual([]); // 2%
    expect(decide(setup({ stopLoss: 99.8 }), equity, { ...on, minStopPct: 0 }, paper).blockers).toEqual([]);
  });

  it('moves the lead stop off a stop cluster and restates reward:risk from it', () => {
    const at = (i: number) => Date.parse('2026-01-06T09:15:00+05:30') + i * 300_000;
    const bars = [100.9, 100.6, 100.52, 100.9, 100.7, 100.5, 100.95, 101.2, 101.5, 101.9, 102, 102.1, 102.2, 102.1, 102.3, 102.4]
      .map((low, i) => ({ ts: at(i), open: low + 0.3, high: low + 0.6, low, close: low + 0.4, volume: 1000 }));
    const signal = { id: 'sig' as SignalId, instrumentKey: 'K', symbol: 'S', style: 'INTRADAY' as const, side: 'BUY' as const,
      entry: 10_280 as Paise, stopLoss: 10_052 as Paise, target: 10_736 as Paise, atr: 0.6, confidence: 80, reasons: ['r'], indicators: {}, generatedAt: 0 };
    const s = setup({ entry: 102.8, stopLoss: 100.52, target: 107.36, rewardRisk: 2,
      votes: [{ strategyId: 'ORB_SUPERTREND', name: 'ORB', style: 'INTRADAY', side: 'BUY', confidence: 80, signal, reasons: [] }] });
    const g = guardSetupStop(s, bars);
    expect(g.stopLoss).toBeLessThan(100.5);
    expect(g.rewardRisk).toBeLessThan(2);
    expect(g.votes[0]!.signal!.stopLoss).toBe(Math.round(g.stopLoss * 100));
  });

  it('takes trend entries only with the NIFTY and in stocks leading it', () => {
    expect(decide(setup({ marketSide: 'SELL' }), equity, on, paper).blockers.join()).toContain('NIFTY is falling — no longs');
    expect(decide(setup({ marketSide: null }), equity, on, paper).blockers.join()).toContain('no clear direction');
    expect(decide(setup({ relStrengthPct: -0.4 }), equity, on, paper).blockers.join()).toContain('-0.40% vs NIFTY — weaker than the market');
    // Without market data at all, nothing trades blind.
    const { marketSide: _m, ...blind } = setup();
    expect(decide(blind, equity, on, paper).blockers.join()).toContain('NIFTY data unavailable');
    // Fades are exempt; an index has no relative strength; both can be switched off.
    expect(decide(setup({ marketSide: 'SELL', relStrengthPct: -1, primaryStrategyId: 'BB_RSI_REVERSION' }), equity, on, paper).blockers).toEqual([]);
    expect(decide(setup({ relStrengthPct: null }), index, { ...on, segments: { ...on.segments, fno: true } }, paper).blockers).toEqual([]);
    expect(decide(setup({ marketSide: 'SELL', relStrengthPct: -1 }), equity, { ...on, marketFilter: false, relativeStrength: false }, paper).blockers).toEqual([]);
  });

  it('restates a trend target at the configured multiple of risk, never a fade\'s', () => {
    const signal = { id: 'sig' as SignalId, instrumentKey: 'K', symbol: 'S', style: 'INTRADAY' as const, side: 'BUY' as const,
      entry: 10_000 as Paise, stopLoss: 9_900 as Paise, target: 10_200 as Paise, atr: 1, confidence: 80, reasons: [], indicators: {}, generatedAt: 0 };
    const vote = (strategyId: string) => ({ strategyId, name: strategyId, style: 'INTRADAY' as const, side: 'BUY' as const, confidence: 80, signal, reasons: [] });
    const t = restateTarget(setup({ votes: [vote('ORB_SUPERTREND')] }), 3);
    expect(t.target).toBe(103);
    expect(t.rewardRisk).toBe(3);
    expect(t.votes[0]!.signal!.target).toBe(10_300);
    const fade = setup({ primaryStrategyId: 'BB_RSI_REVERSION', votes: [vote('BB_RSI_REVERSION')] });
    expect(restateTarget(fade, 3)).toBe(fade);
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

  it('blocks entries when live LTP has chased > maxEntryChaseAtr beyond bar close or trigger', () => {
    const chasedBar = setup({ entry: 102, barCloseEntry: 100.5, atr: 2 }); // 0.75 ATR > 0.5 ATR
    expect(decide(chasedBar, equity, on, paper).blockers.join()).toContain('chased 0.75 ATR past bar close');

    const chasedTrig = setup({ entry: 103, barCloseEntry: 102.5, signalEntry: 101, atr: 2 }); // 1.0 ATR > 0.75 ATR
    expect(decide(chasedTrig, equity, on, paper).blockers.join()).toContain('chased 1.00 ATR past breakout trigger');

    const okEntry = setup({ entry: 101, barCloseEntry: 100.5, signalEntry: 100, atr: 2 }); // 0.25 bar / 0.50 trig
    expect(decide(okEntry, equity, on, paper).blockers).toEqual([]);
  });

  it('caps trend target inside maxDailyAtrMultiple and flags exhausted daily room', () => {
    const signal = { id: 'sig' as SignalId, instrumentKey: 'K', symbol: 'S', style: 'INTRADAY' as const, side: 'BUY' as const,
      entry: 11_000 as Paise, stopLoss: 10_800 as Paise, target: 11_400 as Paise, atr: 1, confidence: 80, reasons: [], indicators: {}, generatedAt: 0 };
    const vote = { strategyId: 'ORB_SUPERTREND', name: 'ORB_SUPERTREND', style: 'INTRADAY' as const, side: 'BUY' as const, confidence: 80, signal, reasons: [] };
    const capped = restateTarget(setup({ entry: 110, stopLoss: 108, target: 114, votes: [vote] }), 3, {
      dayOpen: 100, dailyAtr: 10, maxDailyAtrMultiple: 1.5, // max 115 instead of 116 (3R)
    });
    expect(capped.target).toBe(115);
    expect(capped.rewardRisk).toBe(2.5);

    const exhausted = restateTarget(setup({ entry: 110, stopLoss: 108, target: 114, votes: [vote] }), 3, {
      dayOpen: 100, dailyAtr: 5, maxDailyAtrMultiple: 1.5, // max 107.5 <= entry 110!
    });
    expect(exhausted.invalidReason).toContain('ADR target cap');
  });

  it('identifies stale watched or auto-picked instruments independently of global feed health', () => {
    const ticks = new Map([['A', 99_500], ['B', 90_000]]);
    expect(staleInstruments(['A', 'B', 'C'], ticks, 100_000, 3000)).toEqual(['B', 'C']);
  });
});
