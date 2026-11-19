import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, atr, bollinger, relativeVolume } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal,
  percentileRank, closeLocation, fmt,
} from './common.ts';

export interface BbSqueezeParams {
  readonly bbPeriod: number;
  readonly bbStdDev: number;
  /** Bars of bandwidth history the squeeze is ranked against. */
  readonly squeezeLookback: number;
  /** Bandwidth at or below this percentile of the lookback counts as a squeeze. */
  readonly squeezePercentile: number;
  /** The squeeze must have been present within this many bars before the breakout. */
  readonly squeezeWithinBars: number;
  readonly minRelativeVolume: number;
  readonly atrPeriod: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_BB_SQUEEZE: BbSqueezeParams = {
  bbPeriod: 20,
  bbStdDev: 2,
  squeezeLookback: 60,
  squeezePercentile: 20,
  squeezeWithinBars: 5,
  minRelativeVolume: 1.5,
  atrPeriod: 14,
  minStopAtr: 0.5,
  stopAtrMultiple: 1.5,
  targetRR: 2,
  minConfidence: 65,
};

/**
 * Bollinger squeeze → breakout.
 *
 * Volatility mean-reverts: unusually narrow bands precede expansion. The
 * squeeze says a move is coming, not which way, so direction comes from the
 * first close OUTSIDE the band — and only with volume behind it, because a
 * low-volume poke out of a tight range is the classic false breakout.
 *
 * The squeeze is checked on the bars BEFORE the breakout bar: the breakout
 * itself widens the bands, so testing it on the latest bar would demand the
 * impossible. Bandwidth is a volatility measure, not a session level, so its
 * lookback deliberately spans prior sessions. Only a FRESH break is taken —
 * a close outside the band after several bars already outside is "walking
 * the band", a late entry with the stop far away.
 */
export class BbSqueezeProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Bollinger Squeeze Breakout';
  readonly warmupBars: number;
  private readonly p: BbSqueezeParams;

  constructor(params: BbSqueezeParams = DEFAULT_BB_SQUEEZE) {
    this.p = params;
    this.warmupBars = params.bbPeriod + params.squeezeLookback + params.squeezeWithinBars;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, last } = frame;
    const p = this.p;
    const n = candles.length;

    const c = closes(candles);
    const bb = bollinger(c, p.bbPeriod, p.bbStdDev);
    const upper = bb.upper[n - 1], lower = bb.lower[n - 1], middle = bb.middle[n - 1];
    const prevUpper = bb.upper[n - 2], prevLower = bb.lower[n - 2];
    if (upper == null || lower == null || middle == null || prevUpper == null || prevLower == null) return null;

    const price = last.close;
    const prevClose = c[n - 2]!;
    let side: Side;
    if (price > upper && prevClose <= prevUpper) side = 'BUY';
    else if (price < lower && prevClose >= prevLower) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    // Lowest bandwidth percentile reached in the bars just before the break.
    let squeezePct = Infinity;
    for (let i = n - 1 - p.squeezeWithinBars; i < n - 1; i++) {
      const bw = bb.bandwidth[i];
      if (bw == null) continue;
      const hist = bb.bandwidth.slice(Math.max(0, i - p.squeezeLookback + 1), i + 1)
        .filter((v): v is number => v !== null);
      if (hist.length < p.squeezeLookback) continue;
      squeezePct = Math.min(squeezePct, percentileRank(hist, bw));
    }
    if (squeezePct > p.squeezePercentile) return null;

    const rvol = latest(relativeVolume(candles, 20));
    if (rvol === null || rvol < p.minRelativeVolume) return null;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const bwNow = bb.bandwidth[n - 1] ?? null;
    const bwPrev = bb.bandwidth[n - 2] ?? null;
    const vw = sessionVwap(session);
    const vwNow = vw[vw.length - 1]!;
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;

    const checks: Confluence[] = [
      {
        name: 'squeeze', passed: true, weight: 3,
        detail: `Bollinger squeeze (bandwidth in bottom ${squeezePct.toFixed(0)}% of ${p.squeezeLookback} bars)`,
      },
      {
        name: 'breakout', passed: true, weight: 3,
        detail: `Closed ${long ? 'above upper' : 'below lower'} band ₹${(long ? upper : lower).toFixed(2)}`,
      },
      {
        name: 'volume', passed: true, weight: 3,
        detail: `RVOL ${rvol.toFixed(2)}x on the breakout`,
      },
      {
        name: 'expansion', passed: bwNow !== null && bwPrev !== null && bwNow > bwPrev * 1.1, weight: 1,
        detail: 'Bandwidth expanding',
      },
      {
        name: 'vwap', passed: (price - vwNow) * dir > 0, weight: 2,
        detail: `Price ${long ? 'above' : 'below'} session VWAP`,
      },
      {
        name: 'body', passed: range > 0 && body / range >= 0.5 && (last.close - last.open) * dir > 0
          && closeLocation(last, side) >= 0.7,
        weight: 2,
        detail: 'Decisive breakout bar (large body, close near the extreme)',
      },
      {
        name: 'deepSqueeze', passed: squeezePct <= p.squeezePercentile / 2, weight: 1,
        detail: 'Unusually deep squeeze',
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    // The middle band is the squeeze's centre of gravity: a breakout that falls
    // back through it has failed.
    const stopDistance = clampStop(Math.abs(price - middle), atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        bbUpper: upper,
        bbLower: lower,
        bbMiddle: middle,
        bandwidth: bwNow ?? 0,
        squeezePercentile: squeezePct,
        rvol,
        vwap: vwNow,
      },
    });
  }
}

export const BB_SQUEEZE_BREAKOUT: StrategyDefinition = {
  id: 'BB_SQUEEZE_BREAKOUT',
  name: 'Bollinger Squeeze Breakout',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Bollinger bandwidth in the lowest percentile of its lookback, then a fresh close outside the band on expanding volume.',
  defaults: DEFAULT_BB_SQUEEZE as unknown as StrategyDefinition['defaults'],
  bounds: {
    bbPeriod: { min: 14, max: 30, step: 1 },
    bbStdDev: { min: 1.5, max: 2.5, step: 0.25 },
    squeezeLookback: { min: 30, max: 150, step: 10 },
    squeezePercentile: { min: 5, max: 35, step: 5 },
    squeezeWithinBars: { min: 1, max: 10, step: 1 },
    minRelativeVolume: { min: 1, max: 3, step: 0.25 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 3, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('BB_SQUEEZE_BREAKOUT', new BbSqueezeProfile(
      clampParams(BB_SQUEEZE_BREAKOUT, params) as unknown as BbSqueezeParams,
    ));
  },
};
