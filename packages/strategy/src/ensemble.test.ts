import { describe, it, expect } from 'vitest';
import { FixedClock, newSignalId, rupeesToPaise, type Candle, type Signal } from '@tradeforger/core';
import { analyzeHybrid, setupQuality, COIN_FLIP_CAP } from './ensemble.ts';
import { prefilter, pickUniverse, screen, type QuoteLite, type ScanCandidate } from './screener.ts';
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

  it('leads with the strongest vote allowed to trade, and falls back to the strongest when none is', () => {
    const firingAt = (i: number) => {
      const input = { instrumentKey: 'K', symbol: 'S', intraday: series.slice(0, i + 1), daily: dailies, clock: new FixedClock(new Date(closeOf(series[i]!, '5m'))) };
      return { input, r: analyzeHybrid(input) };
    };
    const busy = [...series.keys()].slice(100).map(firingAt)
      .find(({ r: x }) => x.votes.filter((v) => v.style === 'INTRADAY' && v.signal).length >= 2);
    expect(busy).toBeDefined();
    const { input, r: base } = busy!;
    const top = base.best.INTRADAY!.primaryStrategyId;
    expect(analyzeHybrid(input, { canLead: () => false }).best.INTRADAY!.primaryStrategyId).toBe(top);

    const others = base.votes.filter((v) => v.style === 'INTRADAY' && v.signal && v.strategyId !== top);
    const next = others.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const setup = analyzeHybrid(input, { canLead: (v) => v.strategyId !== top }).best.INTRADAY!;
    expect(setup.primaryStrategyId).toBe(next.strategyId);
    // The stronger vote still counts, as agreement or as conflict.
    expect([...setup.agreeing, ...setup.conflicting]).toContain(top);
  });

  it('ignores votes from strategies that may not vote (failed validation)', () => {
    const busy = [...series.keys()].slice(100).map((i) => {
      const input = { instrumentKey: 'K', symbol: 'S', intraday: series.slice(0, i + 1), daily: dailies, clock: new FixedClock(new Date(closeOf(series[i]!, '5m'))) };
      return { input, r: analyzeHybrid(input) };
    }).find(({ r: x }) => x.best.INTRADAY && [...x.best.INTRADAY.agreeing, ...x.best.INTRADAY.conflicting].length > 0);
    expect(busy).toBeDefined();
    const { input, r: base } = busy!;
    const muted = [...base.best.INTRADAY!.agreeing, ...base.best.INTRADAY!.conflicting][0]!;
    const setup = analyzeHybrid(input, { canVote: (v) => v.strategyId !== muted }).best.INTRADAY!;
    expect(setup.primaryStrategyId).toBe(base.best.INTRADAY!.primaryStrategyId);
    expect([...setup.agreeing, ...setup.conflicting]).not.toContain(muted);
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

  describe('autonomous universe pick', () => {
    const day = (symbol: string, ltp: number, open: number, high: number, low: number, volume = 1e6): QuoteLite =>
      ({ ...q(symbol, ltp, 490, volume), open, high, low });
    const quotes = [
      day('LEADER', 510, 495, 512, 494),   // +4%, above the open, near the high
      day('FADING', 500, 505, 515, 495),   // up on the day but below its open
      day('DOWN', 480, 490, 491, 478),     // falling
      day('QUIET', 490.5, 490, 491, 489),  // +0.1%: not moving
      day('BAND', 540, 495, 540, 494),     // +10%: at an exchange price band
      day('THIN', 510, 495, 512, 494, 100),
    ];

    it('buy only keeps liquid stocks that are up and holding their gains', () => {
      expect(pickUniverse(quotes, { size: 10, minTurnoverCr: 1, side: 'BUY' }).map((x) => x.symbol)).toEqual(['LEADER']);
    });

    it('short only keeps stocks that are down and holding their losses', () => {
      expect(pickUniverse(quotes, { size: 10, minTurnoverCr: 1, side: 'SELL' }).map((x) => x.symbol)).toEqual(['DOWN']);
    });

    it('both takes either kind of mover, never a fading or quiet one', () => {
      const both = pickUniverse(quotes, { size: 10, minTurnoverCr: 1, side: 'BOTH' }).map((x) => x.symbol);
      expect(both).toEqual(['LEADER', 'DOWN']);
    });

    it('respects the price band and the size', () => {
      expect(pickUniverse(quotes, { size: 10, minTurnoverCr: 1, side: 'BUY', maxPrice: 505 })).toEqual([]);
      expect(pickUniverse(quotes, { size: 1, minTurnoverCr: 1, side: 'BOTH' })).toHaveLength(1);
    });

    it('caps vertical movers (>5%) and ranks early 1–3.5% expansion ahead of stretched +4.5% movers', () => {
      const mixed = [
        day('STRETCHED', 512, 495, 513, 494), // +4.49%
        day('SWEETSPOT', 503, 492, 504, 491), // +2.65%
        day('OVEREXT', 520, 495, 521, 494),   // +6.12%: excluded (> 5%)
      ];
      const ranked = pickUniverse(mixed, { size: 10, minTurnoverCr: 1, side: 'BUY' }).map((x) => x.symbol);
      expect(ranked).toEqual(['SWEETSPOT', 'STRETCHED']);
    });

    it('skips wide spreads, surveillance price bands and stocks pinned near a circuit', () => {
      const base = day('OK', 508, 495, 509, 494);
      const quotes: QuoteLite[] = [
        { ...base, bid: 507.95, ask: 508.05, upperCircuit: 588, lowerCircuit: 392 }, // prev close 490, 20% band
        { ...base, symbol: 'WIDE', bid: 506, ask: 509 },
        { ...base, symbol: 'BAND5', upperCircuit: 514.5, lowerCircuit: 465.5 },
        { ...day('PINNED', 535, 500, 536, 499), upperCircuit: 539, lowerCircuit: 441 }, // 10% band, 0.7% below it
        { ...base, symbol: 'ONESIDED', bid: 0, ask: 508.1 },
      ];
      expect(pickUniverse(quotes, { size: 10, minTurnoverCr: 1, side: 'BUY', maxSpreadPct: 0.15, maxChangePct: 12 }).map((x) => x.symbol))
        .toEqual(['OK', 'ONESIDED']);
    });

    it('scales the turnover floor down in early morning so mid/small-cap movers qualify by 09:25', () => {
      // ₹6 Cr turnover (ltp=500, vol=120,000): below ₹25 Cr full-day floor,
      // passes at 09:25 IST (20% of 25 = 5 Cr), rejected at 13:20 IST (100% = 25 Cr).
      const midcap = [day('MIDCAP', 508, 495, 509, 494, 120_000)];
      expect(pickUniverse(midcap, { size: 10, minTurnoverCr: 25, side: 'BUY', sessionMinutes: 565 }).map((x) => x.symbol)).toEqual(['MIDCAP']);
      expect(pickUniverse(midcap, { size: 10, minTurnoverCr: 25, side: 'BUY', sessionMinutes: 800 })).toEqual([]);
    });
  });

  // A real quote's LTP is the last traded price — the candles' last close here.
  const trending: ScanCandidate = { ...q('TREND', at.candles.at(-1)!.close, 1000, 1e6), intraday: at.candles, daily: dailies };
  const flatSeries = intraday('2026-01-05', 6, { seed: 9, start: 1000, drift: 0, vol: 0.0002, volume: 20_000 });
  const flatBars = flatSeries.filter((c) => c.ts <= at.candles.at(-1)!.ts);
  const flat: ScanCandidate = { ...q('FLAT', flatBars.at(-1)!.close, 1000, 1e6), intraday: flatBars, daily: [] };

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

  it('drops a setup the live price has already played out', () => {
    const [top] = screen([trending], {}, at.clock);
    expect(top).toBeDefined();
    const s = top!.setup;
    const through = s.side === 'BUY' ? s.stopLoss * 0.99 : s.stopLoss * 1.01;
    const played = screen([{ ...trending, ltp: through }], { style: s.style }, at.clock);
    expect(played.find((r) => r.setup.style === s.style && r.setup.primaryStrategyId === s.primaryStrategyId)).toBeUndefined();
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
    expect(r.changePct).toBeCloseTo(((trending.ltp - 1000) / 1000) * 100, 2);
    expect(r.turnoverCr).toBeCloseTo((trending.ltp * 1e6) / 1e7, 2);
  });
});
