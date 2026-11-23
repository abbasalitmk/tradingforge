import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, atr, adx, bollinger, rsi } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal, rejectionWick, closeLocation, fmt } from './common.ts';

export interface BbRsiReversionParams {
  readonly atrPeriod: number;
  readonly bbPeriod: number;
  readonly bbStdDev: number;
  readonly rsiPeriod: number;
  readonly rsiOversold: number;
  readonly rsiOverbought: number;
  /** Only in a range: a trending market walks the band instead of reverting from it. */
  readonly maxAdx: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  /** Reward to VWAP over risk; below this the target is too close to bother. */
  readonly minRewardRisk: number;
  readonly minConfidence: number;
}

export const DEFAULT_BB_RSI_REVERSION: BbRsiReversionParams = {
  atrPeriod: 14,
  bbPeriod: 20,
  bbStdDev: 2,
  rsiPeriod: 14,
  rsiOversold: 25,
  rsiOverbought: 75,
  maxAdx: 18,
  stopBufferAtr: 0.2,
  minStopAtr: 0.5,
  maxStopAtr: 2.5,
  minRewardRisk: 1.2,
  minConfidence: 60,
};

/**
 * Intraday mean reversion inside a range: with 5-minute ADX under 18 going
 * into the move, a stretch through the 2-SD Bollinger band with RSI at an
 * extreme (<25 / >75) that closes back inside the band, targeting session
 * VWAP. Counter-trend by design, so it is only trusted where there is no
 * trend to fight.
 */
export class BbRsiReversionProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Bollinger + RSI Mean Reversion';
  readonly warmupBars: number;
  private readonly p: BbRsiReversionParams;

  constructor(params: BbRsiReversionParams = DEFAULT_BB_RSI_REVERSION) {
    this.p = params;
    this.warmupBars = Math.max(params.bbPeriod, params.rsiPeriod, params.atrPeriod) * 2 + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, last } = frame;
    const p = this.p;
    const c = closes(candles);
    const n = c.length;
    const prevBar = candles[n - 2]!;

    // The regime going INTO the stretch: the stretch's own bars lift ADX, so
    // read it before the pierce-and-reclaim pair.
    const adxNow = adx(candles, 14).adx[n - 3] ?? null;
    if (adxNow === null || adxNow >= p.maxAdx) return null;
    const bb = bollinger(c, p.bbPeriod, p.bbStdDev);
    const r = rsi(c, p.rsiPeriod);
    const [lo1, lo0, up1, up0, r1, r0] = [bb.lower[n - 1], bb.lower[n - 2], bb.upper[n - 1], bb.upper[n - 2], r[n - 1], r[n - 2]];
    if (lo1 == null || lo0 == null || up1 == null || up0 == null || r1 == null || r0 == null) return null;

    // The stretch (this bar or the one before) and the close back inside.
    let side: Side;
    if (Math.min(last.low - lo1, prevBar.low - lo0) < 0 && Math.min(r1, r0) < p.rsiOversold
      && last.close > lo1 && last.close > last.open) side = 'BUY';
    else if (Math.max(last.high - up1, prevBar.high - up0) > 0 && Math.max(r1, r0) > p.rsiOverbought
      && last.close < up1 && last.close < last.open) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    const price = last.close;
    const vwNow = sessionVwap(session)[session.length - 1]!;
    const reward = (vwNow - price) * dir;
    if (reward <= 0) return null;
    const extreme = long ? Math.min(last.low, prevBar.low) : Math.max(last.high, prevBar.high);
    const structural = (price - extreme) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    if (reward / stopDistance < p.minRewardRisk) return null;

    const rsiExtreme = long ? Math.min(r1, r0) : Math.max(r1, r0);
    const checks: Confluence[] = [
      { name: 'range', passed: true, weight: 3, detail: `ADX ${fmt(adxNow, 1)} < ${p.maxAdx}: ranging` },
      { name: 'pierce', passed: true, weight: 3, detail: `Pierced the ${p.bbStdDev}-SD ${long ? 'lower' : 'upper'} band` },
      { name: 'rsiExtreme', passed: true, weight: 3, detail: `RSI ${fmt(rsiExtreme, 1)} ${long ? 'oversold' : 'overbought'}` },
      { name: 'backInside', passed: true, weight: 2, detail: 'Closed back inside the band' },
      { name: 'rejectionWick', passed: rejectionWick(last, side) >= 0.3 || rejectionWick(prevBar, side) >= 0.3, weight: 1, detail: 'Rejection wick at the band' },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Reversal bar closed near its extreme' },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const geometry = riskGeometry(side, price, stopDistance, reward);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, adx: adxNow, rsi: rsiExtreme, bbLower: lo1, bbUpper: up1, vwap: vwNow },
    });
  }
}

export const BB_RSI_REVERSION: StrategyDefinition = {
  id: 'BB_RSI_REVERSION',
  name: 'Bollinger + RSI Mean Reversion (intraday)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'ADX under 18; a pierce of the 2-SD Bollinger band with RSI <25 / >75 that closes back inside, targeting session VWAP.',
  counterTrend: true,
  defaults: DEFAULT_BB_RSI_REVERSION as unknown as StrategyDefinition['defaults'],
  bounds: {
    rsiOversold: { min: 15, max: 35, step: 1 },
    rsiOverbought: { min: 65, max: 85, step: 1 },
    maxAdx: { min: 12, max: 25, step: 1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    minRewardRisk: { min: 0.8, max: 3, step: 0.1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('BB_RSI_REVERSION', new BbRsiReversionProfile(clampParams(BB_RSI_REVERSION, params) as unknown as BbRsiReversionParams));
  },
};
