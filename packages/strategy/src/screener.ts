import type { Candle, Clock } from '@tradeforger/core';
import { atr, latest, relativeVolume } from '@tradeforger/indicators';
import { analyzeHybrid, type HybridOptions, type HybridSetup } from './ensemble.ts';
import { getStrategy } from './catalog.ts';
import { completeBars15 } from './bias.ts';

/** What the coarse stage knows about a stock: one quote, no candles. */
export interface QuoteLite {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly name: string;
  readonly ltp: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly prevClose: number;
  readonly volume: number;
}

export interface ScanFilters {
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly minVolume?: number;
  /** Day turnover (ltp × volume) in crores of rupees. */
  readonly minTurnoverCr?: number;
  readonly minChangePct?: number;
  readonly maxChangePct?: number;
  /** ATR as % of price, on the setup's own timeframe. */
  readonly minAtrPct?: number;
  readonly maxAtrPct?: number;
  readonly minRvol?: number;
  readonly side?: 'BUY' | 'SELL' | 'ANY';
  readonly style?: 'INTRADAY' | 'SWING' | 'ANY';
  readonly minQuality?: number;
  readonly minRewardRisk?: number;
  readonly strategies?: string[];
  readonly limit?: number;
}

export interface ScanCandidate extends QuoteLite {
  readonly intraday: readonly Candle[];
  readonly daily: readonly Candle[];
}

export interface ScanResult {
  readonly setup: HybridSetup;
  readonly atrPct: number;
  readonly rvol: number | null;
  readonly changePct: number;
  readonly turnoverCr: number;
  readonly ltp: number;
  readonly name: string;
}

const CRORE = 1e7;

export const changePct = (q: QuoteLite): number =>
  q.prevClose > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0;

export const turnoverCr = (q: QuoteLite): number => (q.ltp * q.volume) / CRORE;

/**
 * Coarse stage: quote-only filters over the whole market, then rank by
 * liquidity × movement and keep the top `maxCandidates`.
 *
 * Ranking by turnover × |change| favours stocks that are both tradeable and
 * actually doing something today — the cheapest proxy for "worth fetching
 * candles for". Log turnover keeps two or three mega-caps from crowding out
 * every mid-cap that is moving.
 */
export function prefilter(quotes: readonly QuoteLite[], f: ScanFilters, maxCandidates: number): QuoteLite[] {
  const passed = quotes.filter((q) => {
    if (!(q.ltp > 0)) return false;
    const ch = changePct(q);
    if (f.minPrice !== undefined && q.ltp < f.minPrice) return false;
    if (f.maxPrice !== undefined && q.ltp > f.maxPrice) return false;
    if (f.minVolume !== undefined && q.volume < f.minVolume) return false;
    if (f.minTurnoverCr !== undefined && turnoverCr(q) < f.minTurnoverCr) return false;
    if (f.minChangePct !== undefined && ch < f.minChangePct) return false;
    if (f.maxChangePct !== undefined && ch > f.maxChangePct) return false;
    return true;
  });
  const score = (q: QuoteLite): number => Math.log10(1 + turnoverCr(q) * CRORE) * (0.25 + Math.abs(changePct(q)));
  return passed.sort((a, b) => score(b) - score(a)).slice(0, Math.max(0, maxCandidates));
}

/** Where the LTP sits in the day's range: 0 at the low, 1 at the high. */
export const rangePosition = (q: QuoteLite): number =>
  q.high > q.low ? (q.ltp - q.low) / (q.high - q.low) : 0.5;

/** A day move smaller than this is not a mover; above max is already over-extended for fresh trend entries. */
export const PICK_CHANGE_PCT = { min: 0.4, max: 5.0 } as const;

export interface UniversePickOptions {
  readonly size: number;
  readonly minTurnoverCr: number;
  readonly minPrice?: number;
  readonly maxPrice?: number;
  readonly minChangePct?: number;
  readonly maxChangePct?: number;
  /** The direction traded. BUY keeps stocks a long can work on, SELL ones a short can. */
  readonly side: 'BUY' | 'SELL' | 'BOTH';
}

/** Up on the day, above the open, upper half of the range — or the mirror for a short. */
const holdsMove = (q: QuoteLite, side: 'BUY' | 'SELL', minCh: number = PICK_CHANGE_PCT.min): boolean => {
  const ch = changePct(q);
  return side === 'BUY'
    ? ch >= minCh && q.ltp >= q.open && rangePosition(q) >= 0.5
    : -ch >= minCh && q.ltp <= q.open && rangePosition(q) <= 0.5;
};

/**
 * The intraday universe for autonomous mode: the day's liquid movers, from
 * one batch-quote pass over the market — no candles.
 *
 * Caps extreme vertical extensions (> 5%) and peaks scoring in the 1.0%–3.5%
 * healthy expansion band so breakout strategies receive fresh setups rather
 * than exhausted +6%–+8% stocks with no remaining ADR room.
 */
export function pickUniverse(quotes: readonly QuoteLite[], o: UniversePickOptions): QuoteLite[] {
  const minCh = o.minChangePct ?? PICK_CHANGE_PCT.min;
  const maxCh = o.maxChangePct ?? PICK_CHANGE_PCT.max;
  const passed = quotes.filter((q) => {
    if (!(q.ltp > 0)) return false;
    if (o.minPrice !== undefined && o.minPrice > 0 && q.ltp < o.minPrice) return false;
    if (o.maxPrice !== undefined && o.maxPrice > 0 && q.ltp > o.maxPrice) return false;
    if (turnoverCr(q) < o.minTurnoverCr) return false;
    if (Math.abs(changePct(q)) > maxCh) return false;
    return o.side === 'BOTH' ? holdsMove(q, 'BUY', minCh) || holdsMove(q, 'SELL', minCh) : holdsMove(q, o.side, minCh);
  });
  const score = (q: QuoteLite): number => {
    const absCh = Math.abs(changePct(q));
    const strength = changePct(q) >= 0 ? rangePosition(q) : 1 - rangePosition(q);
    // Sweet spot for fresh intraday expansion is 0.5–3.5%; steeply penalize stretched +4–5% names.
    const moveWeight = absCh <= 3.5 ? absCh : Math.max(0.25, 3.5 - (absCh - 3.5) * 1.5);
    return Math.log10(1 + turnoverCr(q) * CRORE) * moveWeight * (0.5 + strength);
  };
  return passed.sort((a, b) => score(b) - score(a)).slice(0, Math.max(0, o.size));
}

/**
 * Fine stage: every candidate through the hybrid ensemble, setup-level filters,
 * then rank by quality (ties broken by reward:risk).
 */
export function screen(
  candidates: readonly ScanCandidate[],
  f: ScanFilters,
  clock: Clock,
  opts: HybridOptions = {},
): ScanResult[] {
  const out: ScanResult[] = [];
  for (const c of candidates) {
    const { best } = analyzeHybrid(
      // Scans hold closed bars only; the quote's LTP is what an order would fill at.
      { instrumentKey: c.instrumentKey, symbol: c.symbol, intraday: c.intraday, daily: c.daily, clock, ltp: c.ltp },
      { ...opts, ...(f.strategies && f.strategies.length ? { strategies: f.strategies } : {}) },
    );
    for (const setup of [best.INTRADAY, best.SWING]) {
      // A setup the market already played out (through its stop or target) is not an opportunity.
      if (!setup || setup.invalidReason) continue;
      if (f.style && f.style !== 'ANY' && setup.style !== f.style) continue;
      if (f.side && f.side !== 'ANY' && setup.side !== f.side) continue;
      if (f.minQuality !== undefined && setup.quality < f.minQuality) continue;
      if (f.minRewardRisk !== undefined && setup.rewardRisk < f.minRewardRisk) continue;

      const tf = getStrategy(setup.primaryStrategyId)?.timeframe;
      const bars = setup.style === 'SWING'
        ? c.daily
        : tf === '15m'
          ? completeBars15(c.intraday)
          : c.intraday;
      const a = latest(atr(bars, 14));
      const price = bars[bars.length - 1]?.close ?? c.ltp;
      const atrPct = a !== null && price > 0 ? (a / price) * 100 : 0;
      if (f.minAtrPct !== undefined && atrPct < f.minAtrPct) continue;
      if (f.maxAtrPct !== undefined && atrPct > f.maxAtrPct) continue;
      const rvol = latest(relativeVolume(bars, 20));
      if (f.minRvol !== undefined && (rvol === null || rvol < f.minRvol)) continue;

      out.push({
        setup,
        atrPct: Math.round(atrPct * 100) / 100,
        rvol: rvol !== null ? Math.round(rvol * 100) / 100 : null,
        changePct: Math.round(changePct(c) * 100) / 100,
        turnoverCr: Math.round(turnoverCr(c) * 100) / 100,
        ltp: c.ltp,
        name: c.name,
      });
    }
  }
  out.sort((a, b) => b.setup.quality - a.setup.quality || b.setup.rewardRisk - a.setup.rewardRisk);
  return out.slice(0, f.limit ?? 25);
}
