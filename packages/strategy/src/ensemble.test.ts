import { describe, it, expect } from 'vitest';
import { FixedClock, newSignalId, rupeesToPaise, type Candle, type Signal } from '@tradeforger/core';
import { analyzeHybrid, setupQuality, COIN_FLIP_CAP } from './ensemble.ts';
import { prefilter, screen, type QuoteLite, type ScanCandidate } from './screener.ts';
import { STRATEGY_CATALOG, getStrategy } from './catalog.ts';
import { intraday, daily, closeOf } from './fixtures.ts';

const s = (side: 'BUY' | 'SELL', confidence: number, rr = 2): Signal => ({
  id: newSignalId(), instrumentKey: 'K', symbol: 'S', style: 'INTRADAY', side, atr: 1, confidence,
  entry: rupeesToPaise(100), stopLoss: rupeesToPaise(side === 'BUY' ? 99 : 101),
  target: rupeesToPaise(side === 'BUY' ? 100 + rr : 100 - rr), reasons: ['x'], indicators: {}, generatedAt: 0,
});

describe('setup quality', () => {
  it('starts from the lead confidence at a neutral 2:1', () => {
    expect(setupQuality(s('BUY', 70), [], [])).toBe(70);
  });
  it('rises when independent strategies agree, up to a cap', () => {
    expect(setupQuality(s('BUY', 70), [s('BUY', 60)], [])).toBe(78);
    expect(setupQuality(s('BUY', 70), Array.from({ length: 6 }, () => s('BUY', 60)), [])).toBe(94);
  });
  it('falls when a strategy argues the other way', () => {
    expect(setupQuality(s('BUY', 80), [], [s('SELL', 40)])).toBeLessThan(80);
  });
  it('is capped at a coin flip when the opposition is comparably strong', () => {
    expect(setupQuality(s('BUY', 90), [s('BUY', 80), s('BUY', 80)], [s('SELL', 85)])).toBeLessThanOrEqual(COIN_FLIP_CAP);
  });
  it('rewards a better reward:risk, within limits', () => {
    expect(setupQuality(s('BUY', 70, 3), [], [])).toBe(75);
    expect(setupQuality(s('BUY', 70, 10), [], [])).toBe(80);
  });
  it('stays within 0–100', () => {
    expect(setupQuality(s('BUY', 100, 5), Array.from({ length: 5 }, () => s('BUY', 99)), [])).toBe(100);
    expect(setupQuality(s('BUY', 10), [], [s('SELL', 9), s('SELL', 9), s('SELL', 9)])).toBeGreaterThanOrEqual(0);
  });
});

// A trending session and the first bar at which some intraday strategy fires.
const series = intraday('2026-01-05', 6, { seed: 1, start: 1000, drift: 0.0006, vol: 0.003, volume: 20_000 });
const dailies = daily('2024-01-01', 300, { seed: 1, start: 1000, drift: 0.002, vol: 0.015, volume: 1e6 });
function firstSetup(): { candles: Candle[]; clock: FixedClock } {
  for (let i = 100; i < series.length; i++) {
    const candles = series.slice(0, i + 1);
    const clock = new FixedClock(new Date(closeOf(series[i]!, '5m')));
    if (analyzeHybrid({ instrumentKey: 'K', symbol: 'S', intraday: candles, daily: dailies, clock }).best.INTRADAY) return { candles, clock };
  }
  throw new Error('fixture produced no intraday setup');
}
const at = firstSetup();

describe('hybrid analysis', () => {
  const r = analyzeHybrid({ instrumentKey: 'K', symbol: 'S', intraday: at.candles, daily: dailies, clock: at.clock });

  it('collects one vote per catalog strategy', () => {
    expect(r.votes.map((v) => v.strategyId)).toEqual(STRATEGY_CATALOG.map((d) => d.id));
  });

  it('leads with the most confident firing strategy of each style', () => {
    const setup = r.best.INTRADAY!;
    const firing = r.votes.filter((v) => v.style === 'INTRADAY' && v.signal);
    expect(setup.primaryStrategyId).toBe(firing.reduce((a, b) => (b.confidence > a.confidence ? b : a)).strategyId);
    expect(setup.agreeing.every((id) => firing.find((v) => v.strategyId === id)?.side === setup.side)).toBe(true);
    expect(setup.conflicting.every((id) => firing.find((v) => v.strategyId === id)?.side !== setup.side)).toBe(true);
  });

  it('reports levels in rupees with a consistent reward:risk', () => {
    const x = r.best.INTRADAY!;
    expect(x.rewardRisk).toBeCloseTo(Math.abs(x.target - x.entry) / Math.abs(x.entry - x.stopLoss), 1);
  });

  it('runs only the requested strategies', () => {
    const only = analyzeHybrid({ instrumentKey: 'K', symbol: 'S', intraday: at.candles, daily: dailies, clock: at.clock }, { strategies: ['GMMA_TREND', 'DONCHIAN_BREAKOUT'] });
    expect(only.votes.map((v) => v.strategyId)).toEqual(['DONCHIAN_BREAKOUT', 'GMMA_TREND']);
  });

  it('applies per-strategy params (e.g. an approved registry version)', () => {
    const lead = r.best.INTRADAY!.primaryStrategyId;
    const def = getStrategy(lead)!;
    if (!def.bounds['targetRR']) return;
    const tuned = analyzeHybrid(
      { instrumentKey: 'K', symbol: 'S', intraday: at.candles, daily: dailies, clock: at.clock },
      { strategies: [lead], params: { [lead]: { ...def.defaults, targetRR: def.bounds['targetRR']!.max } } },
    );
    expect(tuned.best.INTRADAY!.rewardRisk).toBeGreaterThan(r.best.INTRADAY!.rewardRisk);
  });
});

describe('screener', () => {
  const q = (symbol: string, ltp: number, prevClose: number, volume: number): QuoteLite => ({
    instrumentKey: `NSE_EQ|${symbol}`, symbol, name: symbol, ltp, open: prevClose, high: ltp, low: prevClose, prevClose, volume,
  });

  it('prefilters on price, volume, turnover and change', () => {
    const quotes = [q('CHEAP', 5, 5, 1e6), q('DEAR', 50_000, 50_000, 100), q('THIN', 500, 500, 10), q('MOVER', 500, 480, 1e6), q('DOWN', 500, 520, 1e6)];
    const out = prefilter(quotes, { minPrice: 20, maxPrice: 10_000, minVolume: 1000, minChangePct: 0 }, 10);
    expect(out.map((x) => x.symbol)).toEqual(['MOVER']);
    expect(prefilter(quotes, { minTurnoverCr: 1 }, 10).map((x) => x.symbol)).toEqual(expect.arrayContaining(['MOVER', 'DOWN']));
  });

  it('ranks liquid movers first and caps the shortlist', () => {
    const out = prefilter([q('A', 500, 500, 1e5), q('B', 500, 450, 1e6), q('C', 500, 495, 1e6)], {}, 2);
    expect(out.map((x) => x.symbol)).toEqual(['B', 'C']);
  });

  const trending: ScanCandidate = { ...q('TREND', 1050, 1000, 1e6), intraday: at.candles, daily: dailies };
  const flatSeries = intraday('2026-01-05', 6, { seed: 9, start: 1000, drift: 0, vol: 0.0002, volume: 20_000 });
  const flat: ScanCandidate = { ...q('FLAT', 1000, 1000, 1e6), intraday: flatSeries.filter((c) => c.ts <= at.candles.at(-1)!.ts), daily: [] };

  it('caps a setup whose stop is inside costs and noise, however many strategies agree', () => {
    const r = screen([flat], {}, at.clock);
    for (const x of r) {
      const riskPct = (Math.abs(x.setup.entry - x.setup.stopLoss) / x.setup.entry) * 100;
      if (riskPct < 0.2) expect(x.setup.quality).toBeLessThanOrEqual(30);
    }
  });

  it('finds the setup, sorted by quality, within the limit', () => {
    const out = screen([flat, trending], {}, at.clock);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.setup.symbol).toBe('TREND');
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.setup.quality).toBeGreaterThanOrEqual(out[i]!.setup.quality);
    expect(screen([flat, trending], { limit: 1 }, at.clock)).toHaveLength(1);
  });

  it('applies style, side, quality and reward:risk filters', () => {
    expect(screen([trending], { style: 'INTRADAY' }, at.clock).every((r) => r.setup.style === 'INTRADAY')).toBe(true);
    expect(screen([trending], { style: 'SWING' }, at.clock).every((r) => r.setup.style === 'SWING')).toBe(true);
    const side = screen([trending], {}, at.clock)[0]!.setup.side;
    expect(screen([trending], { side: side === 'BUY' ? 'SELL' : 'BUY', style: 'INTRADAY' }, at.clock)).toHaveLength(0);
    expect(screen([trending], { minQuality: 101 }, at.clock)).toHaveLength(0);
    expect(screen([trending], { minRewardRisk: 50 }, at.clock)).toHaveLength(0);
  });

  it('reports ATR%, RVOL, change and turnover for each result', () => {
    const r = screen([trending], {}, at.clock)[0]!;
    expect(r.atrPct).toBeGreaterThan(0);
    expect(r.changePct).toBe(5);
    expect(r.turnoverCr).toBeCloseTo((1050 * 1e6) / 1e7, 2);
  });
});
