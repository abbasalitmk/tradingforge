import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { latest, atr } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, priorSession, dayLevels, avgVolume, sessionVwap, clampStop, riskGeometry, buildSignal, closeLocation, fmt,
} from './common.ts';

export interface PdhCprParams {
  readonly atrPeriod: number;
  /** Central pivot range width as % of the pivot: below this the day is coiled. */
  readonly maxCprWidthPct: number;
  /** Breakout bar volume versus the average of the bars before it. */
  readonly minVolumeRatio: number;
  readonly volumePeriod: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_PDH_CPR: PdhCprParams = {
  atrPeriod: 14,
  maxCprWidthPct: 0.3,
  minVolumeRatio: 1.8,
  volumePeriod: 20,
  stopBufferAtr: 0.2,
  minStopAtr: 0.5,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

/** Pivot, bottom and top of the central pivot range from a session's high, low and close. */
export function cpr(h: number, l: number, c: number): { pivot: number; bc: number; tc: number; widthPct: number } {
  const pivot = (h + l + c) / 3;
  const bc = (h + l) / 2;
  const tc = 2 * pivot - bc;
  return { pivot, bc, tc, widthPct: pivot > 0 ? (Math.abs(tc - bc) / pivot) * 100 : Infinity };
}

/**
 * Previous-day high/low breakout on a narrow-CPR day. A narrow central pivot
 * range means yesterday closed mid-range — balance — and balance days tend
 * to resolve into a trend. The first 5-minute close beyond the previous
 * day's high (or low) on 1.8x volume is that resolution. Stop back inside
 * the level.
 */
export class PdhCprProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'PDH/PDL Narrow-CPR Breakout';
  readonly warmupBars: number;
  private readonly p: PdhCprParams;

  constructor(params: PdhCprParams = DEFAULT_PDH_CPR) {
    this.p = params;
    this.warmupBars = Math.max(params.atrPeriod, params.volumePeriod) + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, sessionStart, last } = frame;
    const p = this.p;
    const prev = dayLevels(priorSession(candles, sessionStart));
    if (!prev) return null;
    const range = cpr(prev.high, prev.low, prev.close);
    if (range.widthPct > p.maxCprWidthPct) return null;

    const n = candles.length;
    const before = candles[n - 2]!;
    let side: Side;
    if (last.close > prev.high && before.close <= prev.high) side = 'BUY';
    else if (last.close < prev.low && before.close >= prev.low) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;
    const level = long ? prev.high : prev.low;

    const avg = avgVolume(candles, n - 1, p.volumePeriod);
    const volRatio = avg ? last.volume / avg : 0;
    if (volRatio < p.minVolumeRatio) return null;
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const price = last.close;
    const vwNow = sessionVwap(session)[session.length - 1]!;
    const cprEdge = long ? Math.max(range.tc, range.bc) : Math.min(range.tc, range.bc);

    const checks: Confluence[] = [
      { name: 'narrowCpr', passed: true, weight: 3, detail: `Narrow CPR ${fmt(range.widthPct)}% of pivot` },
      { name: 'breakout', passed: true, weight: 3, detail: `Closed beyond the previous day's ${long ? 'high' : 'low'} ₹${level.toFixed(2)}` },
      { name: 'volume', passed: true, weight: 3, detail: `Breakout volume ${fmt(volRatio, 1)}x average` },
      { name: 'vwapSide', passed: (price - vwNow) * dir > 0, weight: 1, detail: `${long ? 'Above' : 'Below'} session VWAP` },
      { name: 'beyondCpr', passed: (price - cprEdge) * dir > 0, weight: 1, detail: `${long ? 'Above' : 'Below'} the CPR` },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Breakout bar closed near its extreme' },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - level) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow, pdh: prev.high, pdl: prev.low, pivot: range.pivot, cprWidthPct: range.widthPct,
        volumeRatio: volRatio, vwap: vwNow, triggerPrice: level,
      },
    });
  }
}

export const PDH_PDL_CPR: StrategyDefinition = {
  id: 'PDH_PDL_CPR',
  name: 'PDH/PDL Narrow-CPR Breakout',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'On a narrow central-pivot-range day, the first 5-min close beyond the previous day high or low on 1.8x volume; stop back inside the level.',
  defaults: DEFAULT_PDH_CPR as unknown as StrategyDefinition['defaults'],
  bounds: {
    maxCprWidthPct: { min: 0.1, max: 0.6, step: 0.05 },
    minVolumeRatio: { min: 1.2, max: 3, step: 0.1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('PDH_PDL_CPR', new PdhCprProfile(clampParams(PDH_PDL_CPR, params) as unknown as PdhCprParams));
  },
};
