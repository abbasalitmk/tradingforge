import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise } from '@tradeforger/core';
import { evaluate, DEFAULT_LIMITS, type RiskSnapshot } from '@tradeforger/safety';
import { pickUniverse, type QuoteLite } from '@tradeforger/strategy';
import { decide, AutoConfigSchema, type DecisionContext, type Target } from './live.ts';

/*
 * Acceptance check of every entry filter against the AutoPilot settings the
 * production engine runs (GET /auto/config, 27 Nov 2026, after the 20-month review). A clean setup
 * must pass; breaking any one rule must block it with that rule's reason.
 */
const PRODUCTION = AutoConfigSchema.parse({
  enabled: true, targetMode: 'ALL_SCANNED', targetSymbol: 'RELIANCE', minPrice: 50, maxPrice: 3000,
  segments: { intraday: true, swing: false, fno: false }, minQuality: 70, minRewardRisk: 1.5, minNetRewardRisk: 1.25,
  confirmSeconds: 2, strategies: [], maxEntriesPerDay: 5, maxEntriesMorning: 5, maxEntriesAfternoon: 3, maxPerSector: 2,
  reentryCooldownMin: 5, closedBarEntries: true, htfBias: true, htfBiasStrict: false, maxVwapStretchAtr: 5, maxSetupAgeMin: 10,
  minStopPct: 0.65, stopClusterGuard: true, marketFilter: true, marketAboveOpen: true, relativeStrength: true, targetR: 2.5, maxTargetDailyAtr: 1.5,
  minRoomDailyAtr: 0.5, maxEntryChaseAtr: 0.5, stagedTrail: true, maxCostPctOfRisk: 20, maxOpenPositions: 5, maxPerStrategy: 2,
  maxSameSide: 3, trailStop: false, pauseLosingStrategies: true, skipFailedStrategies: true, tradeSide: 'BUY', autoUniverse: true,
  autoUniverseSize: 15, maxLeverage: 3, autoUniverseMinTurnoverCr: 25, maxSpreadPct: 0.15, stallExit: false, stallBars: 4, stallMinR: 0.25,
});

const up = { side: 'BUY' as const, vwapSide: 'BUY' as const, emaSide: 'BUY' as const, close: 101, vwap: 100, ema20: 100.5, ema50: 99, adx: 28, reason: '15-min up' };
type Setup = Parameters<typeof decide>[0];
/** ₹500 entry, 1% stop, 2.5R — inside every production threshold. */
const clean: Setup = {
  instrumentKey: 'NSE_EQ|X', symbol: 'X', style: 'INTRADAY', side: 'BUY', entry: 500, stopLoss: 495, target: 512.5,
  rewardRisk: 2.5, quality: 80, primaryStrategyId: 'INSIDE_BAR_15M', agreeing: [], conflicting: [], votes: [], reasons: [],
  generatedAt: 0, stableSince: 0, stableSeconds: 30, partialBar: false, invalidReason: null, bias: up,
  marketSide: 'BUY', relStrengthPct: 1, vwapStretchAtr: 1, atr: 2, barCloseEntry: 500, signalEntry: 500,
};
const target: Target = { instrumentKey: 'NSE_EQ|X', symbol: 'X', fnoUnderlying: false, cashTradeable: true, sector: 'Banks' };
const ctx: DecisionContext = {
  mode: 'PAPER', approved: () => false, entriesToday: 0, session: 'MORNING', entriesBySession: { MORNING: 0, AFTERNOON: 0 },
  reentryWaitSec: () => 0, open: { total: 0, byStrategy: {}, bySide: { BUY: 0, SELL: 0 }, bySector: {} },
  record: () => null, verdict: () => null,
};
const blockers = (s: Partial<Setup> = {}, c: Partial<DecisionContext> = {}, cfg: Partial<typeof PRODUCTION> = {}) =>
  decide({ ...clean, ...s }, target, { ...PRODUCTION, ...cfg }, { ...ctx, ...c }).blockers;

describe('production AutoPilot filters', () => {
  it('lets a clean setup through', () => {
    expect(blockers()).toEqual([]);
  });

  const cases: Array<[string, () => string[], RegExp]> = [
    ['autopilot off', () => blockers({}, {}, { enabled: false }), /autonomous mode off/],
    ['price below ₹50', () => blockers({ entry: 40, stopLoss: 39.5, target: 41.25 }), /price ₹40\.00 < min ₹50/],
    ['price above ₹3000', () => blockers({ entry: 3500, stopLoss: 3465, target: 3587.5 }), /price ₹3500\.00 > max ₹3000/],
    ['stop under 0.65%', () => blockers({ stopLoss: 497.5, target: 506.25 }), /stop 0\.50% from entry/],
    ['quality under 70', () => blockers({ quality: 65 }), /quality 65 < 70/],
    ['R:R under 1.5', () => blockers({ rewardRisk: 1.2 }), /R:R 1\.20 < 1\.5/],
    ['short while buy-only', () => blockers({ side: 'SELL', stopLoss: 505, target: 487.5, marketSide: 'SELL', relStrengthPct: -1, bias: { ...up, side: 'SELL', vwapSide: 'SELL', emaSide: 'SELL' } }), /direction filter is buy only/],
    ['against the 15-min trend', () => blockers({ bias: { ...up, side: 'SELL', vwapSide: 'SELL', emaSide: 'SELL', reason: 'down' } }), /against a 15-min trend/],
    ['NIFTY falling', () => blockers({ marketSide: 'SELL' }), /NIFTY is falling/],
    ['NIFTY without a clear direction', () => blockers({ marketSide: null }), /NIFTY has no clear direction/],
    ['weaker than NIFTY', () => blockers({ relStrengthPct: -0.4 }), /weaker than the market/],
    ['chasing far from VWAP', () => blockers({ vwapStretchAtr: 6 }), /chases a move 6\.0 ATR from VWAP \(max 5\)/],
    ['entry chased past the bar close', () => blockers({ entry: 502, barCloseEntry: 500 }), /entry chased 1\.00 ATR past bar close/],
    ['not held long enough', () => blockers({ stableSeconds: 1 }), /stable 1s < 2s/],
    ['stale signal', () => blockers({ stableSeconds: 11 * 60 }), /stale: signalling for 11 min/],
    ['already invalidated', () => blockers({ invalidReason: 'price ₹494 already through stop ₹495' }), /already through stop/],
    ['daily entry cap', () => blockers({}, { entriesToday: 5 }), /daily entry cap 5 reached/],
    ['morning entry cap', () => blockers({}, { entriesBySession: { MORNING: 5, AFTERNOON: 0 } }), /morning entry cap 5 reached/],
    ['afternoon entry cap', () => blockers({}, { session: 'AFTERNOON', entriesBySession: { MORNING: 0, AFTERNOON: 3 } }), /afternoon entry cap 3 reached/],
    ['re-entry cooldown', () => blockers({}, { reentryWaitSec: () => 120 }), /re-entry cooldown: X closed recently, 120s left/],
    ['5 positions open', () => blockers({}, { open: { total: 5, byStrategy: {}, bySide: { BUY: 2, SELL: 3 }, bySector: {} } }), /5 positions open \(max 5\)/],
    ['2 from the same strategy', () => blockers({}, { open: { total: 2, byStrategy: { INSIDE_BAR_15M: 2 }, bySide: { BUY: 2, SELL: 0 }, bySector: {} } }), /2 open from INSIDE_BAR_15M \(max 2\)/],
    ['3 longs open', () => blockers({}, { open: { total: 3, byStrategy: {}, bySide: { BUY: 3, SELL: 0 }, bySector: {} } }), /3 long positions open \(max 3\)/],
    ['2 in the same sector', () => blockers({}, { open: { total: 2, byStrategy: {}, bySide: { BUY: 2, SELL: 0 }, bySector: { Banks: 2 } } }), /2 open in Banks \(max 2 per sector\)/],
    ['failed validation', () => blockers({}, { verdict: () => ({ status: 'REJECTED', oosExpectancyR: -0.2 }) }), /failed validation/],
    ['losing record paused', () => blockers({}, { record: () => ({ trades: 25, expectancyR: -0.1 }) }), /paused: -0\.10R expectancy over its last 25 paper trades/],
    ['LIVE needs an approved strategy', () => blockers({}, { mode: 'LIVE' }), /has no APPROVED version \(required in LIVE\)/],
  ];
  for (const [name, run, reason] of cases) {
    it(`blocks: ${name}`, () => {
      const b = run();
      expect(b.some((x) => reason.test(x)), `blockers were: ${JSON.stringify(b)}`).toBe(true);
    });
  }
});

describe('production stock-picking filters', () => {
  const q = (symbol: string, ltp: number, over: Partial<QuoteLite> = {}): QuoteLite => ({
    instrumentKey: `NSE_EQ|${symbol}`, symbol, name: symbol, ltp, open: ltp / 1.015, high: ltp * 1.002, low: ltp / 1.02,
    prevClose: ltp / 1.02, volume: Math.ceil(60e7 / ltp), bid: ltp * 0.9998, ask: ltp * 1.0002, ...over,
  });
  const pick = (quotes: QuoteLite[]) => pickUniverse(quotes, {
    size: PRODUCTION.autoUniverseSize, minTurnoverCr: PRODUCTION.autoUniverseMinTurnoverCr, minPrice: PRODUCTION.minPrice,
    maxPrice: PRODUCTION.maxPrice, side: PRODUCTION.tradeSide, maxSpreadPct: PRODUCTION.maxSpreadPct,
  }).map((x) => x.symbol);

  it('keeps a liquid mover in the band and drops each one that breaks a rule', () => {
    expect(pick([
      q('GOOD', 500),
      q('CHEAP', 40),
      q('PRICEY', 3500),
      q('THIN', 500, { volume: 100_000 }),
      q('WIDE', 500, { bid: 499, ask: 501 }),
      q('BAND5', 500, { upperCircuit: (500 / 1.02) * 1.05, lowerCircuit: (500 / 1.02) * 0.95 }),
      q('FALLING', 500, { prevClose: 510, open: 505 }),
    ])).toEqual(['GOOD']);
  });
});

describe('production loss limits', () => {
  // ₹50,000 risk capital, 2% daily loss limit (TF_DAILY_LOSS_LIMIT_PCT) — mid-session.
  const clock = new FixedClock(new Date('2026-11-27T05:00:00Z'));
  const limits = { ...DEFAULT_LIMITS, dailyLossPct: 2 };
  const snap = (over: Partial<RiskSnapshot> = {}): RiskSnapshot => ({
    startingCapitalPaise: 5_000_000 as Paise, realisedPnlPaise: 0 as Paise, unrealisedPnlPaise: 0 as Paise, openPositions: 0,
    ordersToday: 0, consecutiveLosses: 0, rejectsLast5Min: 0, orderTimestamps: [], lastTickMs: clock.ms(),
    marginUtilisationPct: 0, divergenceDetected: false, manualHalt: false, worstOpenLossPaise: 0 as Paise, ...over,
  });
  const trips = (s: Partial<RiskSnapshot>) => evaluate(snap(s), limits, clock).trips.map((t) => t.id);

  it('allows entries on a clean day', () => {
    expect(evaluate(snap(), limits, clock).allowEntries).toBe(true);
  });
  it('stops new entries at a ₹1,000 (2%) daily loss, realised plus open', () => {
    expect(trips({ realisedPnlPaise: -60_000 as Paise, unrealisedPnlPaise: -40_000 as Paise })).toContain('DAILY_LOSS');
    expect(trips({ realisedPnlPaise: -99_900 as Paise })).not.toContain('DAILY_LOSS');
  });
  it('stops new entries after the losing streak and on a stale feed', () => {
    expect(trips({ consecutiveLosses: limits.maxConsecutiveLosses })).toContain('CONSECUTIVE_LOSSES');
    expect(trips({ lastTickMs: clock.ms() - 15_000 })).toContain('FEED_STALE');
  });
});
