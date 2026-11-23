import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, ema, atr, adx } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { visibleCandles, clampStop, riskGeometry, buildSignal, closeLocation, fmt } from './common.ts';

export interface DonchianBreakoutParams {
  readonly channelPeriod: number;
  readonly volumePeriod: number;
  /** Breakout-day volume vs the trailing average. */
  readonly minVolumeRatio: number;
  readonly minAdx: number;
  readonly adxRisingBars: number;
  readonly trendPeriod: number;
  readonly atrPeriod: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  /** 0/1. Equity delivery cannot be held short overnight in India, so off by default. */
  readonly allowShort: number;
  readonly minConfidence: number;
}

export const DEFAULT_DONCHIAN_BREAKOUT: DonchianBreakoutParams = {
  channelPeriod: 20,
  volumePeriod: 20,
  minVolumeRatio: 1.5,
  minAdx: 20,
  adxRisingBars: 3,
  trendPeriod: 50,
  atrPeriod: 14,
  minStopAtr: 0.5,
  stopAtrMultiple: 2,
  targetRR: 2.5,
  allowShort: 0,
  minConfidence: 60,
};

/**
 * Donchian channel breakout (Turtle-style), daily.
 *
 * A close above the highest high of the previous N days — today excluded,
 * otherwise the channel would include the very bar being tested and could
 * never be broken — on above-average volume. Only the FIRST close beyond the
 * channel is taken; every subsequent day of a trend is also "a new N-day
 * high", and buying each of them is chasing.
 *
 * The stop is the tighter of k·ATR and the N/2-day low (the classic Turtle
 * exit): whichever invalidates the breakout first, never closer than a
 * floor of ATR so ordinary noise does not stop it out.
 */
export class DonchianBreakoutProfile implements StrategyProfile {
  readonly style: TradingStyle = 'SWING';
  readonly name = 'Donchian Channel Breakout';
  readonly warmupBars: number;
  private readonly p: DonchianBreakoutParams;

  constructor(params: DonchianBreakoutParams = DEFAULT_DONCHIAN_BREAKOUT) {
    this.p = params;
    this.warmupBars = Math.max(params.channelPeriod + 2, params.volumePeriod + 1, params.trendPeriod + 5, 14 * 2 + params.adxRisingBars) + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const candles = visibleCandles(ctx.candles, ctx.clock.ms());
    const n = candles.length;
    if (n < this.warmupBars) return null;

    const last = candles[n - 1]!;
    const price = last.close;
    const prev = candles[n - 2]!;

    const channel = (end: number) => {
      const w = candles.slice(end - p.channelPeriod, end);
      return { high: Math.max(...w.map((b) => b.high)), low: Math.min(...w.map((b) => b.low)) };
    };
    const ch = channel(n - 1);
    const prevCh = channel(n - 2);

    let side: Side;
    if (price > ch.high && prev.close <= prevCh.high) side = 'BUY';
    else if (p.allowShort >= 1 && price < ch.low && prev.close >= prevCh.low) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const vols = candles.slice(n - 1 - p.volumePeriod, n - 1).map((b) => b.volume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
    const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
    if (volRatio < p.minVolumeRatio) return null;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const adxSeries = adx(candles, 14).adx;
    const adxNow = adxSeries[n - 1] ?? null;
    const adxThen = adxSeries[n - 1 - p.adxRisingBars] ?? null;

    const c = closes(candles);
    const trend = ema(c, p.trendPeriod);
    const tNow = trend[n - 1] ?? null;
    const tThen = trend[n - 6] ?? null;
    const level = long ? ch.high : ch.low;

    const checks: Confluence[] = [
      {
        name: 'breakout', passed: true, weight: 3,
        detail: `Close beyond ${p.channelPeriod}-day ${long ? 'high' : 'low'} ₹${level.toFixed(2)}`,
      },
      {
        name: 'volume', passed: true, weight: 3,
        detail: `Volume ${volRatio.toFixed(2)}x the ${p.volumePeriod}-day average`,
      },
      {
        name: 'adx', passed: adxNow !== null && adxNow >= p.minAdx, weight: 2,
        detail: `ADX ${fmt(adxNow, 1)} ≥ ${p.minAdx}`,
      },
      {
        name: 'adxRising', passed: adxNow !== null && adxThen !== null && adxNow > adxThen, weight: 1,
        detail: 'ADX rising',
      },
      {
        name: 'trend', passed: tNow !== null && tThen !== null && (price - tNow) * dir > 0 && (tNow - tThen) * dir > 0,
        weight: 2,
        detail: `With the EMA${p.trendPeriod} trend`,
      },
      {
        name: 'strongClose', passed: closeLocation(last, side) >= 0.75, weight: 1,
        detail: `Closed near the day's ${long ? 'high' : 'low'}`,
      },
      {
        // More than an ATR past the level and the "breakout" is already a
        // trend day you are late to; the stop is far, the R:R thin.
        name: 'notExtended', passed: (price - level) * dir <= atrNow, weight: 1,
        detail: 'Within 1 ATR of the breakout level',
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const half = Math.max(2, Math.floor(p.channelPeriod / 2));
    const exitWindow = candles.slice(n - 1 - half, n - 1);
    const exitLevel = long
      ? Math.min(...exitWindow.map((b) => b.low))
      : Math.max(...exitWindow.map((b) => b.high));
    const structural = (price - exitLevel) * dir;
    const atrStop = atrNow * p.stopAtrMultiple;
    const stopDistance = clampStop(structural > 0 ? Math.min(structural, atrStop) : atrStop, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        triggerPrice: Number(level.toFixed(2)),
        channelHigh: ch.high,
        channelLow: ch.low,
        exitLevel,
        volumeRatio: volRatio,
        adx: adxNow ?? 0,
        trendEma: tNow ?? 0,
      },
    });
  }
}

export const DONCHIAN_BREAKOUT: StrategyDefinition = {
  id: 'DONCHIAN_BREAKOUT',
  name: 'Donchian Channel Breakout',
  style: 'SWING',
  timeframe: '1d',
  description: 'First daily close beyond the prior N-day high on above-average volume with ADX filter; stop at the tighter of k·ATR and the N/2-day low.',
  defaults: DEFAULT_DONCHIAN_BREAKOUT as unknown as StrategyDefinition['defaults'],
  bounds: {
    channelPeriod: { min: 10, max: 55, step: 5 },
    volumePeriod: { min: 10, max: 50, step: 5 },
    minVolumeRatio: { min: 1, max: 3, step: 0.25 },
    minAdx: { min: 10, max: 35, step: 1 },
    adxRisingBars: { min: 1, max: 6, step: 1 },
    trendPeriod: { min: 20, max: 100, step: 10 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 5, step: 0.25 },
    allowShort: { min: 0, max: 1, step: 1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('DONCHIAN_BREAKOUT', new DonchianBreakoutProfile(
      clampParams(DONCHIAN_BREAKOUT, params) as unknown as DonchianBreakoutParams,
    ));
  },
};
