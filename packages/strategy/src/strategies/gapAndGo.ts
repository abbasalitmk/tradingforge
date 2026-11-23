import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { istMinutes, SESSION } from '@tradeforger/core';
import { latest, atr } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, priorSession, openingVolumes, sessionVwap, clampStop, riskGeometry, buildSignal, closeLocation, fmt,
} from './common.ts';

export interface GapAndGoParams {
  readonly atrPeriod: number;
  /** Opening gap from the previous close, %: below the floor is noise, above the cap is exhausted. */
  readonly minGapPct: number;
  readonly maxGapPct: number;
  /** The first 15-minute candle, in 5-minute bars. */
  readonly openingBars: number;
  /** Opening volume versus earlier sessions' openings. */
  readonly minOpeningRvol: number;
  /** A gap play is a morning play: no trigger after this many session bars. */
  readonly maxSessionBars: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_GAP_AND_GO: GapAndGoParams = {
  atrPeriod: 14,
  minGapPct: 1.5,
  maxGapPct: 4,
  openingBars: 3,
  minOpeningRvol: 2,
  maxSessionBars: 18,
  stopBufferAtr: 0.1,
  minStopAtr: 0.5,
  maxStopAtr: 3,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * Gap-and-go: a 1.5–4% opening gap on heavy opening volume, entered when a
 * 5-minute bar closes beyond the first 15-minute candle in the gap's
 * direction. The heavy opening says the gap is news being acted on, not a
 * thin overnight print; the break of the first candle says the open did not
 * fill it. Stop beyond the other end of that first candle.
 */
export class GapAndGoProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Gap and Go';
  readonly warmupBars: number;
  private readonly p: GapAndGoParams;

  constructor(params: GapAndGoParams = DEFAULT_GAP_AND_GO) {
    this.p = params;
    this.warmupBars = params.atrPeriod + params.openingBars + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, sessionStart, last } = frame;
    const p = this.p;
    const n = session.length;
    if (n <= p.openingBars || n > p.maxSessionBars) return null;
    if (istMinutes(new Date(session[0]!.ts)) !== SESSION.OPEN) return null;

    const prev = priorSession(candles, sessionStart);
    const pdc = prev[prev.length - 1]?.close;
    if (!pdc) return null;
    const open = session[0]!.open;
    const gapPct = ((open - pdc) / pdc) * 100;
    if (Math.abs(gapPct) < p.minGapPct || Math.abs(gapPct) > p.maxGapPct) return null;
    const side: Side = gapPct > 0 ? 'BUY' : 'SELL';
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const first = session.slice(0, p.openingBars);
    const firstHigh = Math.max(...first.map((b) => b.high));
    const firstLow = Math.min(...first.map((b) => b.low));
    const level = long ? firstHigh : firstLow;
    const before = session[n - 2]!;
    // A fresh break: this bar closed beyond the first candle, the one before did not.
    if (!((last.close - level) * dir > 0 && (before.close - level) * dir <= 0)) return null;

    const baseline = openingVolumes(candles, sessionStart, p.openingBars);
    const avgOpening = baseline.length ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0;
    const openingVol = first.reduce((a, b) => a + b.volume, 0);
    const rvol = avgOpening > 0 ? openingVol / avgOpening : null;
    if (rvol === null || rvol < p.minOpeningRvol) return null;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    const vw = sessionVwap(session);
    const vwNow = vw[n - 1]!;
    const price = last.close;
    const sessionLow = Math.min(...session.map((b) => b.low));
    const sessionHigh = Math.max(...session.map((b) => b.high));
    const avgSessionVol = session.slice(0, n - 1).reduce((a, b) => a + b.volume, 0) / (n - 1);

    const checks: Confluence[] = [
      { name: 'gap', passed: true, weight: 3, detail: `Opened ${fmt(gapPct)}% ${long ? 'above' : 'below'} the previous close ₹${pdc.toFixed(2)}` },
      { name: 'openingRvol', passed: true, weight: 3, detail: `Opening volume ${fmt(rvol, 1)}x earlier sessions' openings` },
      { name: 'freshBreak', passed: true, weight: 3, detail: `Closed beyond the first 15-min candle's ${long ? 'high' : 'low'} ₹${level.toFixed(2)}` },
      { name: 'gapHolding', passed: long ? sessionLow > pdc : sessionHigh < pdc, weight: 2, detail: 'Gap not filled' },
      { name: 'vwapSide', passed: (price - vwNow) * dir > 0, weight: 1, detail: `${long ? 'Above' : 'Below'} session VWAP` },
      { name: 'breakVolume', passed: last.volume > avgSessionVol, weight: 1, detail: 'Break bar volume above the session average' },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Break bar closed near its extreme' },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - (long ? firstLow : firstHigh)) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, gapPct, openingRvol: rvol, firstHigh, firstLow, prevClose: pdc, vwap: vwNow, triggerPrice: level },
    });
  }
}

export const GAP_AND_GO: StrategyDefinition = {
  id: 'GAP_AND_GO',
  name: 'Gap and Go',
  style: 'INTRADAY',
  timeframe: '5m',
  description: '1.5–4% opening gap on 2x opening volume; enter on a 5-min close beyond the first 15-min candle in the gap direction.',
  defaults: DEFAULT_GAP_AND_GO as unknown as StrategyDefinition['defaults'],
  bounds: {
    minGapPct: { min: 0.75, max: 3, step: 0.25 },
    maxGapPct: { min: 3, max: 8, step: 0.5 },
    minOpeningRvol: { min: 1.2, max: 4, step: 0.2 },
    maxSessionBars: { min: 6, max: 36, step: 3 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('GAP_AND_GO', new GapAndGoProfile(clampParams(GAP_AND_GO, params) as unknown as GapAndGoParams));
  },
};
