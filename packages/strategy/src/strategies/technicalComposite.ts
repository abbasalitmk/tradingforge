import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, ema, atr, adx, rsi, bollinger, obv, sma, relativeVolume, latest } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal, fmt } from './common.ts';

export interface TechnicalCompositeParams {
  readonly emaFast: number;
  readonly emaSlow: number;
  readonly adxThreshold: number;
  readonly rsiOverbought: number;
  readonly rsiOversold: number;
  readonly bbPeriod: number;
  readonly obvMaPeriod: number;
  readonly atrPeriod: number;
  readonly minRelativeVolume: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_TECHNICAL_COMPOSITE: TechnicalCompositeParams = {
  emaFast: 12,
  emaSlow: 26,
  adxThreshold: 25,
  rsiOverbought: 70,
  rsiOversold: 30,
  bbPeriod: 20,
  obvMaPeriod: 20,
  atrPeriod: 14,
  minRelativeVolume: 1.2,
  minStopAtr: 1,
  stopAtrMultiple: 1.5,
  targetRR: 1.8,
  minConfidence: 60,
};

/**
 * Three-dimension technical vote, 5-minute (after Vibe-Trading's
 * `technical-basic` skill): trend (EMA12/26 + ADX), mean reversion (RSI and
 * Bollinger room) and volume-price (OBV against its average).
 *
 * The skill holds a position while all three agree; a signal engine has to
 * say when, so this fires on the bar where trend and OBV first line up —
 * every later bar of the same alignment is the same trade, already late.
 */
export class TechnicalCompositeProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Technical Composite';
  readonly warmupBars: number;
  private readonly p: TechnicalCompositeParams;

  constructor(params: TechnicalCompositeParams = DEFAULT_TECHNICAL_COMPOSITE) {
    this.p = params;
    this.warmupBars = Math.max(params.emaSlow * 2, params.bbPeriod + 2, params.obvMaPeriod + 2, 14 * 3);
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const f = intradayFrame(ctx, this.warmupBars);
    if (!f) return null;
    const candles = f.candles;
    const n = candles.length;
    const c = closes(candles);

    const fast = ema(c, p.emaFast), slow = ema(c, p.emaSlow);
    const ob = obv(candles);
    const obMa = sma(ob, p.obvMaPeriod);
    const dirAt = (i: number): 1 | -1 | 0 => {
      const fi = fast[i], si = slow[i], o = ob[i], m = obMa[i];
      if (fi == null || si == null || o === undefined || m == null) return 0;
      if (fi > si && o > m) return 1;
      if (fi < si && o < m) return -1;
      return 0;
    };
    const now = dirAt(n - 1);
    if (now === 0 || dirAt(n - 2) === now) return null;
    const side: Side = now === 1 ? 'BUY' : 'SELL';
    const long = side === 'BUY';
    const dir = now;

    const price = f.last.close;
    const adxNow = adx(candles, 14).adx[n - 1] ?? null;
    const rsiNow = rsi(c, 14)[n - 1] ?? null;
    const rvol = latest(relativeVolume(candles, 20));
    const bb = bollinger(c, p.bbPeriod, 2);
    const bandUp = bb.upper[n - 1] ?? null, bandLo = bb.lower[n - 1] ?? null;
    const vwapNow = sessionVwap(f.session).at(-1) ?? price;

    const atrNow = atr(candles, p.atrPeriod)[n - 1] ?? null;
    if (atrNow === null || atrNow <= 0) return null;
    if (rsiNow === null || (long ? rsiNow >= p.rsiOverbought : rsiNow <= p.rsiOversold)) return null;
    if (p.minRelativeVolume > 0 && (rvol === null || rvol < p.minRelativeVolume)) return null;

    const checks: Confluence[] = [
      {
        name: 'trend', passed: true, weight: 3,
        detail: `EMA${p.emaFast} ${long ? 'above' : 'below'} EMA${p.emaSlow}`,
      },
      {
        name: 'obv', passed: true, weight: 2,
        detail: `OBV ${long ? 'above' : 'below'} its ${p.obvMaPeriod}-bar average`,
      },
      {
        name: 'adx', passed: adxNow !== null && adxNow >= p.adxThreshold, weight: 2,
        detail: `ADX ${fmt(adxNow, 1)} ≥ ${p.adxThreshold}`,
      },
      {
        name: 'rsiRoom', passed: true, weight: 2,
        detail: `RSI ${fmt(rsiNow, 1)} not ${long ? 'overbought' : 'oversold'}`,
      },
      {
        name: 'bandRoom', passed: long ? bandUp !== null && price < bandUp : bandLo !== null && price > bandLo, weight: 1,
        detail: `Inside the Bollinger ${long ? 'upper' : 'lower'} band`,
      },
      {
        name: 'vwapSide', passed: (price - vwapNow) * dir > 0, weight: 1,
        detail: `${long ? 'Above' : 'Below'} session VWAP ${fmt(vwapNow)}`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const swing = candles.slice(n - 6, n);
    const extreme = long ? Math.min(...swing.map((k) => k.low)) : Math.max(...swing.map((k) => k.high));
    const structural = (price - extreme) * dir;
    const stopDistance = clampStop(structural > 0 ? structural : p.stopAtrMultiple * atrNow, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        emaFast: fast[n - 1] ?? 0,
        emaSlow: slow[n - 1] ?? 0,
        adx: adxNow ?? 0,
        rsi: rsiNow,
        rvol: rvol ?? 0,
        obv: ob[n - 1] ?? 0,
        vwap: vwapNow,
      },
    });
  }
}

export const TECHNICAL_COMPOSITE: StrategyDefinition = {
  id: 'TECHNICAL_COMPOSITE',
  name: 'Technical Composite (EMA/ADX + RSI/BB + OBV)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Fires when EMA12/26 trend and OBV first align, weighted by ADX strength, RSI and Bollinger room and VWAP side.',
  defaults: DEFAULT_TECHNICAL_COMPOSITE as unknown as StrategyDefinition['defaults'],
  bounds: {
    emaFast: { min: 5, max: 20, step: 1 },
    emaSlow: { min: 15, max: 50, step: 1 },
    adxThreshold: { min: 15, max: 35, step: 1 },
    rsiOverbought: { min: 60, max: 85, step: 5 },
    rsiOversold: { min: 15, max: 40, step: 5 },
    bbPeriod: { min: 10, max: 40, step: 2 },
    obvMaPeriod: { min: 10, max: 40, step: 5 },
    atrPeriod: { min: 7, max: 28, step: 1 },
    minRelativeVolume: { min: 0.8, max: 2.5, step: 0.1 },
    minStopAtr: { min: 0.5, max: 2, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 3, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.2 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('TECHNICAL_COMPOSITE', new TechnicalCompositeProfile(
      clampParams(TECHNICAL_COMPOSITE, params) as unknown as TechnicalCompositeParams,
    ));
  },
};
