import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, ema, atr, rsi, adx } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal,
  rejectionWick, closeLocation, fmt,
} from './common.ts';

export interface VwapPullbackParams {
  readonly atrPeriod: number;
  readonly emaFast: number;
  readonly emaSlow: number;
  /** How many recent bars (trigger bar included) may contain the VWAP touch. */
  readonly pullbackBars: number;
  /** "Near VWAP" = the pullback extreme came within this many ATRs of it. */
  readonly touchAtr: number;
  /** A pullback that CLOSES this far through VWAP has broken the trend. */
  readonly maxPierceAtr: number;
  /** Share of pre-pullback session closes that must sit on the trend side. */
  readonly minTrendShare: number;
  readonly minWickRatio: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  /** Session bars required before the pullback window — no trend exists at 09:20. */
  readonly minSessionBars: number;
  readonly minConfidence: number;
}

export const DEFAULT_VWAP_PULLBACK: VwapPullbackParams = {
  atrPeriod: 14,
  emaFast: 9,
  emaSlow: 21,
  pullbackBars: 5,
  touchAtr: 0.3,
  maxPierceAtr: 0.5,
  minTrendShare: 0.7,
  minWickRatio: 0.3,
  stopBufferAtr: 0.25,
  minStopAtr: 0.75,
  maxStopAtr: 2.5,
  targetRR: 1.8,
  minSessionBars: 8,
  minConfidence: 60,
};

/**
 * VWAP pullback on a trend day.
 *
 * VWAP is the price institutions benchmark their fills against, so on a
 * genuine trend day the first return to it is where trapped late sellers
 * (or buyers, for shorts) get absorbed. The edge is NOT "price touched VWAP":
 * on a chop day price crosses VWAP every few bars. It is the combination of
 *  - a session that has spent most of its time on one side of VWAP,
 *  - fast EMA still above slow (the pullback has not become a reversal),
 *  - a touch that does not CLOSE meaningfully through VWAP, and
 *  - a trigger bar that closes back in the trend direction, ideally leaving
 *    a rejection wick into the VWAP zone.
 * The stop goes beyond the pullback extreme (where the thesis is wrong), held
 * inside an ATR band so a freak wick cannot make the risk unreasonable.
 */
export class VwapPullbackProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'VWAP Trend Pullback';
  readonly warmupBars: number;
  private readonly p: VwapPullbackParams;

  constructor(params: VwapPullbackParams = DEFAULT_VWAP_PULLBACK) {
    this.p = params;
    this.warmupBars = Math.max(params.emaSlow, params.atrPeriod) + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, last } = frame;
    const p = this.p;
    const n = session.length;
    const windowStart = n - p.pullbackBars;
    if (windowStart < p.minSessionBars) return null;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    const adxNow = latest(adx(candles, 14).adx);
    if (adxNow === null || adxNow < 18) return null;

    const vw = sessionVwap(session);
    const vwNow = vw[n - 1]!;
    const c = closes(candles);
    const eFast = latest(ema(c, p.emaFast));
    const eSlow = latest(ema(c, p.emaSlow));
    if (eFast === null || eSlow === null) return null;

    const price = last.close;
    let side: Side;
    if (price > vwNow && eFast > eSlow) side = 'BUY';
    else if (price < vwNow && eFast < eSlow) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    // Trend day: before the pullback began, closes lived on the trend side.
    let onSide = 0;
    let maxExcursion = 0;
    for (let i = 0; i < windowStart; i++) {
      const bar = session[i]!;
      if ((bar.close - vw[i]!) * dir > 0) onSide++;
      maxExcursion = Math.max(maxExcursion, ((long ? bar.high : bar.low) - vw[i]!) * dir);
    }
    const trendShare = onSide / windowStart;
    if (trendShare < p.minTrendShare) return null;

    // The pullback: some bar in the window reached the VWAP zone, and no bar
    // closed decisively through it.
    let touched = false;
    let extreme = long ? Infinity : -Infinity;
    let pierced = false;
    for (let i = windowStart; i < n; i++) {
      const bar = session[i]!;
      const gap = long ? bar.low - vw[i]! : vw[i]! - bar.high;
      if (gap <= p.touchAtr * atrNow) touched = true;
      extreme = long ? Math.min(extreme, bar.low) : Math.max(extreme, bar.high);
      if ((vw[i]! - bar.close) * dir > p.maxPierceAtr * atrNow) pierced = true;
    }
    if (!touched || pierced) return null;

    // Trigger: the latest bar closes back in the trend direction, in the
    // favourable half of its range.
    const resumes = (last.close - last.open) * dir > 0 && closeLocation(last, side) >= 0.5;
    if (!resumes) return null;

    const wick = rejectionWick(last, side);
    const vwBefore = vw[Math.max(0, windowStart - 1)]!;
    const rsiNow = latest(rsi(c, 14));
    const prev = candles[n - 2]!;
    const pullbackVols = session.slice(windowStart, n - 1).map((b) => b.volume);
    const avgPullbackVol = pullbackVols.length
      ? pullbackVols.reduce((a, b) => a + b, 0) / pullbackVols.length
      : last.volume;
    // Confirmation: either break the pullback bar's extreme OR reject cleanly off VWAP with strong close + volume.
    const brokePullback = long ? last.close > prev.high : last.close < prev.low;
    const strongRejection = wick >= p.minWickRatio && closeLocation(last, side) >= 0.6 && last.volume >= avgPullbackVol;
    if (!brokePullback && !strongRejection) return null;
    if (rsiNow === null || (long ? rsiNow < 45 || rsiNow >= 72 : rsiNow > 55 || rsiNow <= 28)) return null;

    const checks: Confluence[] = [
      {
        name: 'trendDay', passed: true, weight: 3,
        detail: `Trend day: ${(trendShare * 100).toFixed(0)}% of session closes ${long ? 'above' : 'below'} VWAP`,
      },
      {
        name: 'ema', passed: true, weight: 2,
        detail: `EMA${p.emaFast} ${long ? '>' : '<'} EMA${p.emaSlow}`,
      },
      {
        name: 'vwapTouch', passed: true, weight: 3,
        detail: `Pulled back to VWAP ₹${vwNow.toFixed(2)} without closing through it`,
      },
      {
        name: 'rejectionWick', passed: wick >= p.minWickRatio, weight: 2,
        detail: `Rejection wick ${(wick * 100).toFixed(0)}% of trigger bar`,
      },
      {
        name: 'extension', passed: maxExcursion >= atrNow, weight: 2,
        detail: `Trend leg extended ${fmt(maxExcursion / atrNow, 1)} ATR from VWAP before pulling back`,
      },
      {
        name: 'vwapSlope', passed: (vwNow - vwBefore) * dir > 0, weight: 2,
        detail: `VWAP sloping ${long ? 'up' : 'down'}`,
      },
      {
        name: 'triggerVolume', passed: last.volume > avgPullbackVol, weight: 1,
        detail: 'Trigger bar volume above the pullback average',
      },
      {
        // Room left in the move: not already stretched at the trigger.
        name: 'rsi', passed: rsiNow !== null && (long ? rsiNow > 40 && rsiNow < 70 : rsiNow < 60 && rsiNow > 30),
        weight: 1,
        detail: `RSI ${fmt(rsiNow, 1)} not stretched`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - extreme) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        vwap: vwNow,
        emaFast: eFast,
        emaSlow: eSlow,
        trendShare,
        pullbackExtreme: extreme,
        wick,
        rsi: rsiNow ?? 0,
      },
    });
  }
}

export const VWAP_PULLBACK: StrategyDefinition = {
  id: 'VWAP_PULLBACK',
  name: 'VWAP Trend Pullback',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Trend day (price held one side of session VWAP, EMA9/21 aligned) pulls back to VWAP and resumes with a rejection bar.',
  defaults: DEFAULT_VWAP_PULLBACK as unknown as StrategyDefinition['defaults'],
  bounds: {
    pullbackBars: { min: 3, max: 10, step: 1 },
    touchAtr: { min: 0.1, max: 1, step: 0.1 },
    maxPierceAtr: { min: 0.2, max: 1.5, step: 0.1 },
    minTrendShare: { min: 0.55, max: 0.95, step: 0.05 },
    minWickRatio: { min: 0.1, max: 0.6, step: 0.05 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minSessionBars: { min: 4, max: 30, step: 1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('VWAP_PULLBACK', new VwapPullbackProfile(
      clampParams(VWAP_PULLBACK, params) as unknown as VwapPullbackParams,
    ));
  },
};
