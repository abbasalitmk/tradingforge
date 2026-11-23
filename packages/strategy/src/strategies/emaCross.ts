import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, ema, atr, adx, relativeVolume } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { completeBars15 } from '../bias.ts';
import { intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal, closeLocation, fmt } from './common.ts';

export interface EmaCrossParams {
  readonly atrPeriod: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  /** 5-minute ADX the cross needs — a cross in a flat market is a coin flip. */
  readonly minAdx: number;
  /** Bars back for the swing the stop sits beyond. */
  readonly swingBars: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_EMA_CROSS: EmaCrossParams = {
  atrPeriod: 14,
  emaFast: 9,
  emaSlow: 21,
  minAdx: 22,
  swingBars: 5,
  stopBufferAtr: 0.1,
  minStopAtr: 0.5,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * 9/21 EMA crossover on closed 5-minute bars, taken only when the 15-minute
 * EMA20/50 trend points the same way and the 5-minute ADX shows a trend. The
 * cross alone whipsaws; aligned with the higher timeframe it is the moment a
 * pullback inside that trend ends. Stop beyond the recent swing.
 */
export class EmaCrossProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = '9/21 EMA Crossover';
  readonly warmupBars: number;
  private readonly p: EmaCrossParams;

  constructor(params: EmaCrossParams = DEFAULT_EMA_CROSS) {
    this.p = params;
    this.warmupBars = Math.max(params.emaSlow, params.atrPeriod) * 2 + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, last } = frame;
    const p = this.p;
    const c = closes(candles);
    const n = c.length;
    const fast = ema(c, p.emaFast);
    const slow = ema(c, p.emaSlow);
    const [f1, s1, f0, s0] = [fast[n - 1], slow[n - 1], fast[n - 2], slow[n - 2]];
    if (f1 == null || s1 == null || f0 == null || s0 == null) return null;
    let side: Side;
    if (f1 > s1 && f0 <= s0) side = 'BUY';
    else if (f1 < s1 && f0 >= s0) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const c15 = completeBars15(candles).map((b) => b.close);
    const e20 = latest(ema(c15, 20));
    const e50 = latest(ema(c15, 50));
    if (e20 === null || e50 === null || (e20 - e50) * dir <= 0) return null;

    const adxNow = latest(adx(candles, 14).adx);
    if (adxNow === null || adxNow <= p.minAdx) return null;
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const price = last.close;
    const vwNow = sessionVwap(session)[session.length - 1]!;
    const rvol = latest(relativeVolume(candles, 20));
    const recent = candles.slice(-p.swingBars);
    const swing = long ? Math.min(...recent.map((b) => b.low)) : Math.max(...recent.map((b) => b.high));

    const checks: Confluence[] = [
      { name: 'cross', passed: true, weight: 3, detail: `EMA${p.emaFast} crossed ${long ? 'above' : 'below'} EMA${p.emaSlow} on the closed bar` },
      { name: 'mtf15', passed: true, weight: 3, detail: `15-min EMA20 ${long ? '>' : '<'} EMA50` },
      { name: 'adx', passed: true, weight: 2, detail: `ADX ${fmt(adxNow, 1)} > ${p.minAdx}` },
      { name: 'vwapSide', passed: (price - vwNow) * dir > 0, weight: 1, detail: `${long ? 'Above' : 'Below'} session VWAP` },
      { name: 'volume', passed: rvol !== null && rvol >= 1.2, weight: 1, detail: `RVOL ${fmt(rvol)}x` },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Cross bar closed near its extreme' },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - swing) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, emaFast: f1, emaSlow: s1, ema20_15m: e20, ema50_15m: e50, adx: adxNow, vwap: vwNow, swing },
    });
  }
}

export const EMA_CROSS: StrategyDefinition = {
  id: 'EMA_CROSS_9_21',
  name: '9/21 EMA Crossover (15-min aligned)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: '5-min EMA9/21 cross on a closed bar, with the 15-min EMA20/50 trend agreeing and 5-min ADX above 22; stop beyond the recent swing.',
  defaults: DEFAULT_EMA_CROSS as unknown as StrategyDefinition['defaults'],
  bounds: {
    minAdx: { min: 15, max: 35, step: 1 },
    swingBars: { min: 3, max: 12, step: 1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('EMA_CROSS_9_21', new EmaCrossProfile(clampParams(EMA_CROSS, params) as unknown as EmaCrossParams));
  },
};
