import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import {
  closes, latest, ema, atr, supertrend, adx, relativeVolume,
} from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal, closeLocation, fmt,
} from './common.ts';

export interface SupertrendMomentumParams {
  readonly atrPeriod: number;
  readonly stPeriod: number;
  readonly stMultiplier: number;
  /** The flip must have happened within this many bars (1 = on the latest bar). */
  readonly flipWithinBars: number;
  readonly emaPeriod: number;
  /** EMA slope is measured over this many bars. */
  readonly slopeBars: number;
  readonly minRelativeVolume: number;
  readonly adxRisingBars: number;
  readonly minAdx: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_SUPERTREND_MOMENTUM: SupertrendMomentumParams = {
  atrPeriod: 14,
  stPeriod: 10,
  stMultiplier: 3,
  flipWithinBars: 3,
  emaPeriod: 21,
  slopeBars: 3,
  minRelativeVolume: 1.5,
  adxRisingBars: 3,
  minAdx: 15,
  minStopAtr: 0.5,
  stopAtrMultiple: 1.5,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * Fresh Supertrend flip with momentum behind it.
 *
 * A Supertrend flip is the moment the market has moved ~3 ATRs against the
 * prior trend line — late as a signal, but a robust regime marker. On its own
 * it whipsaws in ranges. The flip is only taken when it is FRESH (the move is
 * not already exhausted), the EMA slope agrees (the flip is not a spike into
 * a still-falling average), participation expanded (RVOL on some bar since
 * the flip), and trend strength is building (ADX rising). A flip carried over
 * from yesterday's close does not count — that is a gap, a different trade.
 */
export class SupertrendMomentumProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Supertrend Flip Momentum';
  readonly warmupBars: number;
  private readonly p: SupertrendMomentumParams;

  constructor(params: SupertrendMomentumParams = DEFAULT_SUPERTREND_MOMENTUM) {
    this.p = params;
    this.warmupBars = Math.max(params.emaPeriod + params.slopeBars, params.atrPeriod * 2, params.stPeriod + 2) + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, sessionStart, session, last } = frame;
    const p = this.p;
    const n = candles.length;

    const st = supertrend(candles, p.stPeriod, p.stMultiplier);
    const dirNow = st.direction[n - 1];
    if (dirNow === null || dirNow === undefined) return null;

    let flipIdx = -1;
    for (let k = 0; k < p.flipWithinBars; k++) {
      const i = n - 1 - k;
      const d = st.direction[i], prev = st.direction[i - 1];
      if (i <= 0 || d === null || d === undefined || prev === null || prev === undefined) break;
      if (d !== prev) { flipIdx = i; break; }
    }
    if (flipIdx < 0 || flipIdx < sessionStart) return null;

    const side: Side = dirNow === 1 ? 'BUY' : 'SELL';
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const c = closes(candles);
    const e = ema(c, p.emaPeriod);
    const eNow = e[n - 1];
    const eThen = e[n - 1 - p.slopeBars];
    if (eNow === null || eNow === undefined || eThen === null || eThen === undefined) return null;
    const slope = eNow - eThen;
    if (slope * dir <= 0) return null;

    const rv = relativeVolume(candles, 20);
    let maxRvol = 0;
    for (let i = flipIdx; i < n; i++) maxRvol = Math.max(maxRvol, rv[i] ?? 0);
    if (maxRvol < p.minRelativeVolume) return null;

    const adxSeries = adx(candles, 14).adx;
    const adxNow = adxSeries[n - 1] ?? null;
    const adxThen = adxSeries[n - 1 - p.adxRisingBars] ?? null;
    const adxRising = adxNow !== null && adxThen !== null && adxNow > adxThen;

    const price = last.close;
    const vw = sessionVwap(session);
    const vwNow = vw[vw.length - 1]!;
    const stLine = st.value[n - 1] ?? null;

    const checks: Confluence[] = [
      {
        name: 'flip', passed: true, weight: 3,
        detail: `Supertrend flipped ${long ? 'up' : 'down'} ${n - 1 - flipIdx} bar(s) ago`,
      },
      {
        name: 'emaSlope', passed: true, weight: 3,
        detail: `EMA${p.emaPeriod} sloping ${long ? 'up' : 'down'}`,
      },
      {
        name: 'volume', passed: true, weight: 3,
        detail: `RVOL ${maxRvol.toFixed(2)}x since the flip`,
      },
      {
        name: 'adxRising', passed: adxRising, weight: 2,
        detail: `ADX rising (${fmt(adxThen, 1)} → ${fmt(adxNow, 1)})`,
      },
      {
        name: 'adx', passed: adxNow !== null && adxNow >= p.minAdx, weight: 1,
        detail: `ADX ${fmt(adxNow, 1)} ≥ ${p.minAdx}`,
      },
      {
        name: 'emaSide', passed: (price - eNow) * dir > 0, weight: 2,
        detail: `Price ${long ? 'above' : 'below'} EMA${p.emaPeriod}`,
      },
      {
        name: 'vwap', passed: (price - vwNow) * dir > 0, weight: 2,
        detail: `Price ${long ? 'above' : 'below'} session VWAP`,
      },
      {
        name: 'strongClose', passed: closeLocation(last, side) >= 0.6, weight: 1,
        detail: `Closed in the ${long ? 'upper' : 'lower'} part of the bar`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    // The Supertrend line is where the regime call is invalidated; held inside
    // an ATR band because right after a flip it can sit ~3 ATR away.
    const raw = stLine !== null ? Math.abs(price - stLine) : p.stopAtrMultiple * atrNow;
    const stopDistance = clampStop(raw, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        supertrend: stLine ?? 0,
        barsSinceFlip: n - 1 - flipIdx,
        ema: eNow,
        emaSlope: slope,
        rvol: maxRvol,
        adx: adxNow ?? 0,
        vwap: vwNow,
      },
    });
  }
}

export const SUPERTREND_MOMENTUM: StrategyDefinition = {
  id: 'SUPERTREND_MOMENTUM',
  name: 'Supertrend Flip Momentum',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Fresh Supertrend flip aligned with EMA21 slope, confirmed by RVOL expansion and rising ADX.',
  defaults: DEFAULT_SUPERTREND_MOMENTUM as unknown as StrategyDefinition['defaults'],
  bounds: {
    stPeriod: { min: 7, max: 14, step: 1 },
    stMultiplier: { min: 2, max: 4, step: 0.5 },
    flipWithinBars: { min: 1, max: 6, step: 1 },
    emaPeriod: { min: 13, max: 34, step: 1 },
    slopeBars: { min: 2, max: 6, step: 1 },
    minRelativeVolume: { min: 1, max: 3, step: 0.25 },
    adxRisingBars: { min: 1, max: 6, step: 1 },
    minAdx: { min: 10, max: 30, step: 1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 3, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('SUPERTREND_MOMENTUM', new SupertrendMomentumProfile(
      clampParams(SUPERTREND_MOMENTUM, params) as unknown as SupertrendMomentumParams,
    ));
  },
};
