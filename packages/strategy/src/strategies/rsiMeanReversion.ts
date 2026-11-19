import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, sma, ema, atr, rsi } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { visibleCandles, riskGeometry, buildSignal, fmt } from './common.ts';

export interface RsiMeanReversionParams {
  readonly rsiPeriod: number;
  readonly oversold: number;
  readonly overbought: number;
  /** Long-term trend filter (SMA). */
  readonly trendPeriod: number;
  /** EMA used instead when history is shorter than `trendPeriod`. */
  readonly fallbackTrendPeriod: number;
  /** Short MA the close should be stretched beyond (Connors-style). */
  readonly exitMaPeriod: number;
  readonly atrPeriod: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  /** Bars searched for the prior swing high/low used as the reversion target. */
  readonly swingLookback: number;
  /** 0/1. Equity delivery cannot be held short overnight in India, so off by default. */
  readonly allowShort: number;
  readonly minConfidence: number;
}

export const DEFAULT_RSI_MEAN_REVERSION: RsiMeanReversionParams = {
  rsiPeriod: 2,
  oversold: 10,
  overbought: 90,
  trendPeriod: 200,
  fallbackTrendPeriod: 100,
  exitMaPeriod: 5,
  atrPeriod: 14,
  stopAtrMultiple: 2,
  targetRR: 2,
  swingLookback: 10,
  allowShort: 0,
  minConfidence: 60,
};

/**
 * Short-period RSI mean reversion inside a long-term trend.
 *
 * RSI(2) collapsing below ~10 inside a stock that is above its 200-day
 * average is a short-term overreaction against the dominant trend — one of
 * the most robust documented daily edges in equities. The trend filter is the
 * whole point: the same oversold reading in a downtrend is a falling knife.
 *
 * The natural objective of a reversion trade is the level price fell from, so
 * the target is the prior swing high when that is a reachable, worthwhile
 * (≥ 1R) objective nearer than the R:R target; otherwise the R:R target.
 */
export class RsiMeanReversionProfile implements StrategyProfile {
  readonly style: TradingStyle = 'SWING';
  readonly name = 'RSI Mean Reversion';
  readonly warmupBars: number;
  private readonly p: RsiMeanReversionParams;

  constructor(params: RsiMeanReversionParams = DEFAULT_RSI_MEAN_REVERSION) {
    this.p = params;
    this.warmupBars = Math.max(params.fallbackTrendPeriod, params.atrPeriod, params.swingLookback) + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const candles = visibleCandles(ctx.candles, ctx.clock.ms());
    const n = candles.length;
    if (n < this.warmupBars) return null;

    const c = closes(candles);
    const last = candles[n - 1]!;
    const price = last.close;

    const useSma = n >= p.trendPeriod + 20;
    const trendSeries = useSma ? sma(c, p.trendPeriod) : ema(c, p.fallbackTrendPeriod);
    const trendLabel = useSma ? `SMA${p.trendPeriod}` : `EMA${p.fallbackTrendPeriod}`;
    const ma = trendSeries[n - 1] ?? null;
    const maThen = trendSeries[n - 21] ?? null;
    const rsiNow = latest(rsi(c, p.rsiPeriod));
    if (ma === null || rsiNow === null) return null;

    let side: Side;
    if (price > ma && rsiNow <= p.oversold) side = 'BUY';
    else if (p.allowShort >= 1 && price < ma && rsiNow >= p.overbought) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const shortMa = latest(sma(c, p.exitMaPeriod));
    let against = 0;
    for (let i = n - 1; i > 0 && (c[i - 1]! - c[i]!) * dir > 0; i--) against++;
    const drop3 = (c[Math.max(0, n - 4)]! - price) * dir;

    const stopDistance = atrNow * p.stopAtrMultiple;
    const lookback = candles.slice(Math.max(0, n - 1 - p.swingLookback), n - 1);
    const swing = long
      ? Math.max(...lookback.map((b) => b.high))
      : Math.min(...lookback.map((b) => b.low));
    const swingRoom = (swing - price) * dir;
    const rrDistance = stopDistance * p.targetRR;
    const useSwing = swingRoom >= stopDistance && swingRoom < rrDistance;
    const targetDistance = useSwing ? swingRoom : rrDistance;

    const checks: Confluence[] = [
      {
        name: 'trend', passed: true, weight: 3,
        detail: `Close ${long ? 'above' : 'below'} ${trendLabel} ₹${ma.toFixed(2)}`,
      },
      {
        name: 'rsiExtreme', passed: true, weight: 3,
        detail: `RSI(${p.rsiPeriod}) ${rsiNow.toFixed(1)} ${long ? 'oversold' : 'overbought'}`,
      },
      {
        name: 'rsiDeep', passed: long ? rsiNow <= p.oversold / 2 : rsiNow >= 100 - (100 - p.overbought) / 2,
        weight: 1,
        detail: 'Extreme reading',
      },
      {
        name: 'trendSlope', passed: maThen !== null && (ma - maThen) * dir > 0, weight: 2,
        detail: `${trendLabel} ${long ? 'rising' : 'falling'}`,
      },
      {
        name: 'stretched', passed: shortMa !== null && (shortMa - price) * dir > 0, weight: 1,
        detail: `Close ${long ? 'below' : 'above'} SMA${p.exitMaPeriod}`,
      },
      {
        name: 'streak', passed: against >= 2, weight: 1,
        detail: `${against} consecutive ${long ? 'down' : 'up'} closes`,
      },
      {
        name: 'room', passed: swingRoom >= stopDistance, weight: 2,
        detail: `Prior swing ${long ? 'high' : 'low'} ₹${swing.toFixed(2)} at least 1R away`,
      },
      {
        // An orderly dip, not a collapse: a > 4 ATR three-day move is news,
        // and news-driven gaps do not mean-revert on schedule.
        name: 'orderly', passed: drop3 <= 4 * atrNow, weight: 1,
        detail: `Pullback orderly (${fmt(drop3 / atrNow, 1)} ATR over 3 days)`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const geometry = riskGeometry(side, price, stopDistance, targetDistance);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        rsi: rsiNow,
        trendMa: ma,
        shortMa: shortMa ?? 0,
        swingLevel: swing,
        targetFromSwing: useSwing ? 1 : 0,
      },
    });
  }
}

export const RSI_MEAN_REVERSION: StrategyDefinition = {
  id: 'RSI_MEAN_REVERSION',
  name: 'RSI Mean Reversion',
  style: 'SWING',
  timeframe: '1d',
  description: 'Short-period RSI deeply oversold while above the 200-day trend (EMA100 on short history); target the prior swing high or R:R.',
  defaults: DEFAULT_RSI_MEAN_REVERSION as unknown as StrategyDefinition['defaults'],
  bounds: {
    rsiPeriod: { min: 2, max: 4, step: 1 },
    oversold: { min: 3, max: 25, step: 1 },
    overbought: { min: 75, max: 97, step: 1 },
    trendPeriod: { min: 100, max: 250, step: 10 },
    fallbackTrendPeriod: { min: 50, max: 150, step: 10 },
    exitMaPeriod: { min: 3, max: 10, step: 1 },
    stopAtrMultiple: { min: 1, max: 4, step: 0.25 },
    targetRR: { min: 1, max: 4, step: 0.25 },
    swingLookback: { min: 5, max: 30, step: 1 },
    allowShort: { min: 0, max: 1, step: 1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('RSI_MEAN_REVERSION', new RsiMeanReversionProfile(
      clampParams(RSI_MEAN_REVERSION, params) as unknown as RsiMeanReversionParams,
    ));
  },
};
