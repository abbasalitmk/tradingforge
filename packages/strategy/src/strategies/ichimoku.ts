import type { Candle, Signal, Side, TradingStyle } from '@tradeforger/core';
import { latest, atr } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { visibleCandles, clampStop, riskGeometry, buildSignal, fmt } from './common.ts';

export interface IchimokuParams {
  readonly tenkanPeriod: number;
  readonly kijunPeriod: number;
  readonly senkouBPeriod: number;
  /** Cloud shift forward and Chikou shift back, in bars. */
  readonly displacement: number;
  readonly atrPeriod: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  /** 0/1. Equity delivery cannot be held short overnight in India, so off by default. */
  readonly allowShort: number;
  readonly minConfidence: number;
}

export const DEFAULT_ICHIMOKU: IchimokuParams = {
  tenkanPeriod: 9,
  kijunPeriod: 26,
  senkouBPeriod: 52,
  displacement: 26,
  atrPeriod: 14,
  minStopAtr: 0.75,
  stopAtrMultiple: 2.5,
  targetRR: 2,
  allowShort: 0,
  minConfidence: 60,
};

/** Midpoint of the highest high and lowest low over `period` bars ending at `end` (inclusive). */
function midpoint(candles: readonly Candle[], end: number, period: number): number | null {
  if (end - period + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = end - period + 1; i <= end; i++) {
    hi = Math.max(hi, candles[i]!.high);
    lo = Math.min(lo, candles[i]!.low);
  }
  return (hi + lo) / 2;
}

/**
 * Ichimoku Kinko Hyo, daily (after Vibe-Trading's `ichimoku` skill).
 *
 * Fires only on a Tenkan/Kijun cross. The cloud under today's bar is the one
 * projected `displacement` bars ago, so nothing here reads the future: Senkou
 * spans are computed from bars that had already closed. Being above a rising
 * (A > B) cloud and a Chikou above the price it is compared with turn a bare
 * cross into a trend entry; without them the cross is noise inside a range.
 * The stop sits beyond the Kijun, the system's own equilibrium line.
 */
export class IchimokuProfile implements StrategyProfile {
  readonly style: TradingStyle = 'SWING';
  readonly name = 'Ichimoku Cloud';
  readonly warmupBars: number;
  private readonly p: IchimokuParams;

  constructor(params: IchimokuParams = DEFAULT_ICHIMOKU) {
    this.p = params;
    this.warmupBars = params.senkouBPeriod + params.displacement + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const candles = visibleCandles(ctx.candles, ctx.clock.ms());
    const n = candles.length;
    if (n < this.warmupBars) return null;

    const tenkan = (i: number) => midpoint(candles, i, p.tenkanPeriod);
    const kijun = (i: number) => midpoint(candles, i, p.kijunPeriod);
    const tNow = tenkan(n - 1), kNow = kijun(n - 1);
    const tPrev = tenkan(n - 2), kPrev = kijun(n - 2);
    if (tNow === null || kNow === null || tPrev === null || kPrev === null) return null;

    let side: Side;
    if (tNow > kNow && tPrev <= kPrev) side = 'BUY';
    else if (p.allowShort >= 1 && tNow < kNow && tPrev >= kPrev) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const at = n - 1 - p.displacement;
    const tAt = tenkan(at), kAt = kijun(at);
    const spanA = tAt !== null && kAt !== null ? (tAt + kAt) / 2 : null;
    const spanB = midpoint(candles, at, p.senkouBPeriod);
    if (spanA === null || spanB === null) return null;
    const cloudTop = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);

    const last = candles[n - 1]!;
    const price = last.close;
    const chikouRef = candles[n - 1 - p.displacement]!.close;
    const kijunThen = kijun(n - 6);

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const checks: Confluence[] = [
      {
        name: 'tkCross', passed: true, weight: 3,
        detail: `Tenkan ${fmt(tNow)} crossed ${long ? 'above' : 'below'} Kijun ${fmt(kNow)}`,
      },
      {
        name: 'cloudSide', passed: long ? price > cloudTop : price < cloudBottom, weight: 3,
        detail: `Price ${long ? 'above' : 'below'} the cloud (${fmt(cloudBottom)}–${fmt(cloudTop)})`,
      },
      {
        name: 'cloudColour', passed: (spanA - spanB) * dir > 0, weight: 2,
        detail: `${long ? 'Bullish' : 'Bearish'} cloud (Span A ${long ? '>' : '<'} Span B)`,
      },
      {
        name: 'chikou', passed: (price - chikouRef) * dir > 0, weight: 2,
        detail: `Chikou ${long ? 'above' : 'below'} price ${p.displacement} bars ago`,
      },
      {
        name: 'kijunSlope', passed: kijunThen !== null && (kNow - kijunThen) * dir > 0, weight: 1,
        detail: `Kijun ${long ? 'rising' : 'falling'}`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - kNow) * dir;
    const stopDistance = clampStop(structural > 0 ? structural : p.stopAtrMultiple * atrNow, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, tenkan: tNow, kijun: kNow, spanA, spanB, chikouRef },
    });
  }
}

export const ICHIMOKU_CLOUD: StrategyDefinition = {
  id: 'ICHIMOKU_CLOUD',
  name: 'Ichimoku Cloud',
  style: 'SWING',
  timeframe: '1d',
  description: 'Daily Tenkan/Kijun cross confirmed by price vs the cloud, cloud colour and the Chikou span; stop beyond the Kijun.',
  defaults: DEFAULT_ICHIMOKU as unknown as StrategyDefinition['defaults'],
  bounds: {
    tenkanPeriod: { min: 5, max: 20, step: 1 },
    kijunPeriod: { min: 15, max: 40, step: 1 },
    senkouBPeriod: { min: 30, max: 80, step: 2 },
    displacement: { min: 15, max: 35, step: 1 },
    atrPeriod: { min: 7, max: 28, step: 1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    allowShort: { min: 0, max: 1, step: 1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('ICHIMOKU_CLOUD', new IchimokuProfile(clampParams(ICHIMOKU_CLOUD, params) as unknown as IchimokuParams));
  },
};
