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
  maxCprWidthPct: 0.9,
  minVolumeRatio: 1.3,
  volumePeriod: 20,
  stopBufferAtr: 0.3,
  minStopAtr: 1.0,
  maxStopAtr: 3.0,
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
  description: 'On a narrow central-pivot-range day (<=0.9%), the first 5-min close beyond the previous day high or low on 1.3x volume; 1.0+ ATR structural stop.',
  defaults: DEFAULT_PDH_CPR as unknown as StrategyDefinition['defaults'],
  bounds: {
    maxCprWidthPct: { min: 0.3, max: 1.5, step: 0.1 },
    minVolumeRatio: { min: 1.1, max: 2.5, step: 0.1 },
    stopBufferAtr: { min: 0.1, max: 1, step: 0.1 },
    minStopAtr: { min: 0.5, max: 1.75, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.5, max: 3.5, step: 0.25 },
    minConfidence: { min: 45, max: 85, step: 5 },
  },
  create(params) {
    return tagged('PDH_PDL_CPR', new PdhCprProfile(clampParams(PDH_PDL_CPR, params) as unknown as PdhCprParams));
  },
};

export const PDH_PDL_CPR_15M: StrategyDefinition = {
  id: 'PDH_PDL_CPR_15M',
  name: 'PDH/PDL Narrow-CPR Breakout (15m)',
  style: 'INTRADAY',
  timeframe: '15m',
  description: '15-minute narrow-CPR PDH/PDL breakout on >=1.5x volume with wider ATR stops to lower transaction cost drag.',
  defaults: {
    ...DEFAULT_PDH_CPR,
    minVolumeRatio: 1.5,
    minStopAtr: 0.75,
    maxStopAtr: 2.5,
    targetRR: 2,
  } as unknown as StrategyDefinition['defaults'],
  bounds: PDH_PDL_CPR.bounds,
  create(params) {
    return tagged('PDH_PDL_CPR_15M', new PdhCprProfile(clampParams(PDH_PDL_CPR_15M, params) as unknown as PdhCprParams));
  },
};
