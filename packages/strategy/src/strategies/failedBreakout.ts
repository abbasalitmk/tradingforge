import type { Candle, Signal, Side, TradingStyle } from '@tradeforger/core';
import { latest, atr } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, priorSession, dayLevels, avgVolume, sessionVwap, clampStop, riskGeometry, buildSignal,
  rejectionWick, closeLocation, fmt,
} from './common.ts';

export interface FailedBreakoutParams {
  readonly atrPeriod: number;
  /** The opening range, in 5-minute bars. */
  readonly openingBars: number;
  /** A breakout on less than this multiple of average volume had no conviction behind it. */
  readonly maxBreakoutVolumeRatio: number;
  readonly volumePeriod: number;
  /** The breakout must fail — close back inside — within this many bars. */
  readonly maxBarsOutside: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_FAILED_BREAKOUT: FailedBreakoutParams = {
  atrPeriod: 14,
  openingBars: 3,
  maxBreakoutVolumeRatio: 1.2,
  volumePeriod: 20,
  maxBarsOutside: 2,
  stopBufferAtr: 0.1,
  minStopAtr: 0.5,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

interface Level { readonly name: string; readonly price: number; readonly fade: Side }

/**
 * Failed-breakout trap: a thin-volume close beyond the opening-range or
 * previous-day high (or low) that closes back inside within two bars. The
 * breakout buyers are now trapped above a level that rejected them, and
 * their stops are the fuel for the move the other way. Stop beyond the
 * failed breakout's extreme.
 */
export class FailedBreakoutProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Failed Breakout Trap';
  readonly warmupBars: number;
  private readonly p: FailedBreakoutParams;

  constructor(params: FailedBreakoutParams = DEFAULT_FAILED_BREAKOUT) {
    this.p = params;
    this.warmupBars = Math.max(params.atrPeriod, params.volumePeriod) + params.maxBarsOutside + 2;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, sessionStart, last } = frame;
    const p = this.p;
    const n = session.length;
    if (n < p.openingBars + 2) return null;

    const opening = session.slice(0, p.openingBars);
    const levels: Level[] = [
      { name: 'opening-range high', price: Math.max(...opening.map((b) => b.high)), fade: 'SELL' },
      { name: 'opening-range low', price: Math.min(...opening.map((b) => b.low)), fade: 'BUY' },
    ];
    const prev = dayLevels(priorSession(candles, sessionStart));
    if (prev) {
      levels.push({ name: 'previous-day high', price: prev.high, fade: 'SELL' });
      levels.push({ name: 'previous-day low', price: prev.low, fade: 'BUY' });
    }

    for (const lv of levels) {
      const dir = lv.fade === 'BUY' ? 1 : -1;
      // The break is AGAINST the fade direction: beyond means (close - level) * dir < 0.
      const inside = (b: Candle): boolean => (b.close - lv.price) * dir >= 0;
      if (!inside(last)) continue;
      for (let k = 1; k <= p.maxBarsOutside; k++) {
        const firstOut = n - 1 - k;
        if (firstOut < p.openingBars) break;
        const outside = session.slice(firstOut, n - 1);
        if (!outside.every((b) => !inside(b))) continue;
        if (!inside(session[firstOut - 1]!)) continue;
        const idx = sessionStart + firstOut;
        const avg = avgVolume(candles, idx, p.volumePeriod);
        const volRatio = avg ? candles[idx]!.volume / avg : Infinity;
        if (volRatio >= p.maxBreakoutVolumeRatio) continue;
        return this.signal(ctx, candles, session, last, lv, outside, volRatio, k);
      }
    }
    return null;
  }

  private signal(
    ctx: StrategyContext, candles: readonly Candle[], session: readonly Candle[], last: Candle,
    lv: Level, outside: readonly Candle[], volRatio: number, barsOutside: number,
  ): Signal | null {
    const p = this.p;
    const side = lv.fade;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    const price = last.close;
    const extreme = long ? Math.min(...outside.map((b) => b.low), last.low) : Math.max(...outside.map((b) => b.high), last.high);
    const vwNow = sessionVwap(session)[session.length - 1]!;

    const checks: Confluence[] = [
      { name: 'trap', passed: true, weight: 3, detail: `Broke the ${lv.name} ₹${lv.price.toFixed(2)} and closed back inside within ${barsOutside} bar${barsOutside > 1 ? 's' : ''}` },
      { name: 'thinBreakout', passed: true, weight: 3, detail: `Breakout volume only ${fmt(volRatio, 2)}x average` },
      { name: 'reversalBar', passed: (last.close - last.open) * dir > 0, weight: 2, detail: `Reclaim bar closed ${long ? 'up' : 'down'}` },
      { name: 'rejectionWick', passed: rejectionWick(last, side) >= 0.3, weight: 1, detail: 'Rejection wick through the level' },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Reclaim bar closed near its extreme' },
      { name: 'vwapRoom', passed: (vwNow - price) * dir > 0, weight: 1, detail: `Session VWAP ₹${vwNow.toFixed(2)} on the target side` },
    ];
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - extreme) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, level: lv.price, breakoutVolumeRatio: volRatio, trapExtreme: extreme, vwap: vwNow },
    });
  }
}

export const FAILED_BREAKOUT_TRAP: StrategyDefinition = {
  id: 'FAILED_BREAKOUT_TRAP',
  name: 'Failed Breakout Trap',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'A low-volume (<1.2x) close beyond the opening-range or previous-day high/low that closes back inside within 2 bars; fade it, stop beyond the failed extreme.',
  counterTrend: true,
  defaults: DEFAULT_FAILED_BREAKOUT as unknown as StrategyDefinition['defaults'],
  bounds: {
    maxBreakoutVolumeRatio: { min: 0.8, max: 1.8, step: 0.1 },
    maxBarsOutside: { min: 1, max: 4, step: 1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('FAILED_BREAKOUT_TRAP', new FailedBreakoutProfile(clampParams(FAILED_BREAKOUT_TRAP, params) as unknown as FailedBreakoutParams));
  },
};
