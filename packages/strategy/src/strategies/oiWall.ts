import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { latest, atr } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { intradayFrame, clampStop, riskGeometry, buildSignal, rejectionWick, closeLocation, fmt } from './common.ts';

export interface OiWallParams {
  readonly atrPeriod: number;
  /** A probe within this many ATRs of the wall counts as testing it. */
  readonly touchAtr: number;
  /** Bars back the test may have happened. */
  readonly touchBars: number;
  /** A chain older than this says nothing about the wall now. */
  readonly maxChainAgeMin: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_OI_WALL: OiWallParams = {
  atrPeriod: 14,
  touchAtr: 0.3,
  touchBars: 3,
  maxChainAgeMin: 5,
  stopBufferAtr: 0.2,
  minStopAtr: 0.5,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * Option-chain OI wall reversal, for F&O underlyings. The strike with the
 * most put OI below the money is where writers will defend; the most call OI
 * above is where they cap. A test of the wall that closes back off it, while
 * writers are still ADDING OI at that strike, is a bounce (or rejection) the
 * positioning supports. Stop beyond the wall. Needs a live chain, so it never
 * fires in a backtest or on a stock without one.
 */
export class OiWallProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Option Chain OI Wall Reversal';
  readonly warmupBars: number;
  private readonly p: OiWallParams;

  constructor(params: OiWallParams = DEFAULT_OI_WALL) {
    this.p = params;
    this.warmupBars = params.atrPeriod + params.touchBars + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const oi = ctx.options;
    if (!oi || !(oi.spot > 0)) return null;
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    if (ctx.clock.ms() - oi.at > this.p.maxChainAgeMin * 60_000) return null;
    const { candles, last } = frame;
    const p = this.p;
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    // The bars may be the future's, the strikes are in spot terms.
    const basis = last.close - oi.spot;
    const support = oi.putWall + basis;
    const resistance = oi.callWall + basis;
    const recent = candles.slice(-p.touchBars);
    const low = Math.min(...recent.map((b) => b.low));
    const high = Math.max(...recent.map((b) => b.high));
    const price = last.close;

    let side: Side;
    let wall: number;
    let oiChange: number;
    if (Math.abs(low - support) <= p.touchAtr * atrNow && price > support && last.close > last.open) {
      side = 'BUY'; wall = support; oiChange = oi.putWallOiChange;
    } else if (Math.abs(high - resistance) <= p.touchAtr * atrNow && price < resistance && last.close < last.open) {
      side = 'SELL'; wall = resistance; oiChange = oi.callWallOiChange;
    } else return null;
    if (oiChange <= 0) return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const structural = (price - wall) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const targetDistance = stopDistance * p.targetRR;
    const otherWall = long ? resistance : support;
    const room = (otherWall - price) * dir;

    const checks: Confluence[] = [
      { name: 'wallTest', passed: true, weight: 3, detail: `Tested the ${long ? 'put' : 'call'} OI wall ${long ? oi.putWall : oi.callWall} and closed back off it` },
      { name: 'oiAdded', passed: true, weight: 3, detail: `${long ? 'Put' : 'Call'} writers adding at the wall (+${fmt(oiChange, 0)} OI)` },
      { name: 'reversalBar', passed: true, weight: 2, detail: `Bar closed ${long ? 'up' : 'down'} off the wall` },
      { name: 'rejectionWick', passed: recent.some((b) => rejectionWick(b, side) >= 0.3), weight: 1, detail: 'Rejection wick at the wall' },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Closed near its extreme' },
      { name: 'room', passed: room >= targetDistance, weight: 2, detail: `${long ? 'Call' : 'Put'} wall ${long ? oi.callWall : oi.putWall} beyond the target` },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const geometry = riskGeometry(side, price, stopDistance, targetDistance);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, putWall: oi.putWall, callWall: oi.callWall, basis, oiChange, spot: oi.spot },
    });
  }
}

export const OI_WALL_REVERSAL: StrategyDefinition = {
  id: 'OI_WALL_REVERSAL',
  name: 'Option Chain OI Wall Reversal (F&O)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Bounce off the peak put-OI strike (or rejection at the peak call-OI strike) while writers are still adding OI there; stop beyond the wall. Needs a live option chain.',
  counterTrend: true,
  defaults: DEFAULT_OI_WALL as unknown as StrategyDefinition['defaults'],
  bounds: {
    touchAtr: { min: 0.1, max: 1, step: 0.1 },
    touchBars: { min: 1, max: 6, step: 1 },
    maxChainAgeMin: { min: 1, max: 15, step: 1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('OI_WALL_REVERSAL', new OiWallProfile(clampParams(OI_WALL_REVERSAL, params) as unknown as OiWallParams));
  },
};
