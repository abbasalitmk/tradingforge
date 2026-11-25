import type { Candle, Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, atr, rsi } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { intradayFrame, sessionVwap, clampStop, riskGeometry, buildSignal, closeLocation, fmt } from './common.ts';

export interface SmcParams {
  /** Bars on each side that a swing high/low must dominate. */
  readonly swingLength: number;
  /** How far back a fair-value gap still counts as fresh. */
  readonly fvgLookback: number;
  readonly volumePeriod: number;
  readonly minRelativeVolume: number;
  readonly atrPeriod: number;
  readonly minStopAtr: number;
  /** Widest stop allowed, in ATRs; a setup whose structure needs more is skipped, not tightened. */
  readonly stopAtrMultiple: number;
  /** Clearance beyond the structural extreme, in ATRs, so the stop is not on the level itself. */
  readonly stopBufferAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_SMC: SmcParams = {
  swingLength: 5,
  fvgLookback: 12,
  volumePeriod: 20,
  minRelativeVolume: 1.2,
  atrPeriod: 14,
  minStopAtr: 0.5,
  stopAtrMultiple: 3.5,
  stopBufferAtr: 0.15,
  targetRR: 2,
  minConfidence: 55,
};

interface Swing {
  readonly index: number;
  readonly price: number;
}

/**
 * Swing highs and lows that were already confirmed before the last bar: a
 * swing needs `len` bars after it, and the bar that breaks it must not be one
 * of them, or the break would be confirming its own level.
 */
function confirmedSwings(c: readonly Candle[], len: number): { highs: Swing[]; lows: Swing[] } {
  const highs: Swing[] = [], lows: Swing[] = [];
  for (let j = len; j <= c.length - 2 - len; j++) {
    let isHigh = true, isLow = true;
    for (let k = j - len; k <= j + len && (isHigh || isLow); k++) {
      if (k === j) continue;
      if (c[k]!.high >= c[j]!.high) isHigh = false;
      if (c[k]!.low <= c[j]!.low) isLow = false;
    }
    if (isHigh) highs.push({ index: j, price: c[j]!.high });
    if (isLow) lows.push({ index: j, price: c[j]!.low });
  }
  return { highs, lows };
}

/** Most recent three-bar imbalance in the last `lookback` bars, if any. */
function recentFvg(c: readonly Candle[], lookback: number, side: Side): { low: number; high: number } | null {
  for (let k = c.length - 1; k >= Math.max(2, c.length - lookback); k--) {
    const a = c[k - 2]!, b = c[k]!;
    if (side === 'BUY' && b.low > a.high) return { low: a.high, high: b.low };
    if (side === 'SELL' && b.high < a.low) return { low: b.high, high: a.low };
  }
  return null;
}

/**
 * Smart Money Concepts market structure, 5-minute (after Vibe-Trading's `smc` skill).
 *
 * The trigger is the first close beyond the most recent confirmed swing: a
 * break of structure (BOS) when it continues higher-highs/higher-lows (or the
 * bearish mirror), a change of character (ChoCH) when it breaks against them.
 * A fresh fair-value gap on the same side is the footprint of the aggressive
 * order flow that institutional-flow traders look for. The stop goes beyond
 * the opposite swing, which is where the structural read is proven wrong.
 */
export class SmcProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Smart Money Structure';
  readonly warmupBars: number;
  private readonly p: SmcParams;

  constructor(params: SmcParams = DEFAULT_SMC) {
    this.p = params;
    this.warmupBars = Math.max(4 * params.swingLength + 10, params.volumePeriod + 2, params.atrPeriod * 2);
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const f = intradayFrame(ctx, this.warmupBars);
    if (!f) return null;
    const c = f.candles;
    const n = c.length;
    const last = f.last;
    const prev = c[n - 2]!;

    const { highs, lows } = confirmedSwings(c, p.swingLength);
    if (highs.length < 2 || lows.length < 2) return null;
    const sh = highs[highs.length - 1]!, sl = lows[lows.length - 1]!;

    let side: Side;
    if (last.close > sh.price && prev.close <= sh.price) side = 'BUY';
    else if (last.close < sl.price && prev.close >= sl.price) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const higherHigh = sh.price > highs[highs.length - 2]!.price;
    const higherLow = sl.price > lows[lows.length - 2]!.price;
    const withStructure = long ? higherHigh && higherLow : !higherHigh && !higherLow;
    const kind = withStructure ? 'BOS' : 'ChoCH';

    const fvg = recentFvg(c, p.fvgLookback, side);
    const vwapNow = sessionVwap(f.session).at(-1) ?? last.close;
    const vols = c.slice(n - 1 - p.volumePeriod, n - 1).map((b) => b.volume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const volRatio = avgVol > 0 ? last.volume / avgVol : 0;
    const range = last.high - last.low;
    const bodyShare = range > 0 ? Math.abs(last.close - last.open) / range : 0;

    const atrNow = latest(atr(c, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    if (p.minRelativeVolume > 0 && volRatio < p.minRelativeVolume) return null;
    const rsiNow = latest(rsi(closes(c), 14));
    if (rsiNow === null || (long ? rsiNow >= 72 : rsiNow <= 28)) return null;
    const level = long ? sh.price : sl.price;
    const price = last.close;

    const checks: Confluence[] = [
      {
        name: 'structureBreak', passed: true, weight: 3,
        detail: `${kind}: close ${long ? 'above' : 'below'} swing ${long ? 'high' : 'low'} ₹${level.toFixed(2)}`,
      },
      {
        name: 'fvg', passed: fvg !== null, weight: 3,
        detail: fvg ? `${long ? 'Bullish' : 'Bearish'} fair-value gap ₹${fvg.low.toFixed(2)}–${fvg.high.toFixed(2)}` : 'Fair-value gap',
      },
      {
        name: 'withStructure', passed: withStructure, weight: 2,
        detail: `Continues ${long ? 'higher highs and higher lows' : 'lower highs and lower lows'}`,
      },
      {
        name: 'vwapSide', passed: (price - vwapNow) * dir > 0, weight: 1,
        detail: `${long ? 'Above' : 'Below'} session VWAP ${fmt(vwapNow)}`,
      },
      {
        name: 'volume', passed: true, weight: 1,
        detail: `Break on ${volRatio.toFixed(2)}x average volume`,
      },
      {
        name: 'displacement', passed: bodyShare >= 0.5 && closeLocation(last, side) >= 0.7, weight: 1,
        detail: 'Decisive breaking candle',
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    // Beyond the most extreme price since the opposite swing, not the swing
    // itself: a low printed after it (too recent to be a confirmed swing) has
    // already broken that level, and a stop left above it sits in the noise.
    const swing = long ? sl : sh;
    const since = c.slice(swing.index);
    const extreme = long ? Math.min(...since.map((b) => b.low)) : Math.max(...since.map((b) => b.high));
    const structural = (price - extreme) * dir + p.stopBufferAtr * atrNow;
    // Tightening a stop that structure puts further away moves it inside the
    // structure; the setup is simply too wide to take.
    if (structural > p.stopAtrMultiple * atrNow) return null;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        swingHigh: sh.price,
        swingLow: sl.price,
        stopExtreme: extreme,
        vwap: vwapNow,
        volumeRatio: volRatio,
        rvol: volRatio,
        rsi: rsiNow,
        choch: withStructure ? 0 : 1,
        fvg: fvg ? 1 : 0,
      },
    });
  }
}

export const SMC_STRUCTURE: StrategyDefinition = {
  id: 'SMC_STRUCTURE',
  name: 'Smart Money Structure (BOS/ChoCH + FVG)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'First 5-min close beyond the last confirmed swing (BOS or ChoCH), weighted by a fresh fair-value gap, VWAP side and volume; stop beyond the opposite swing.',
  defaults: DEFAULT_SMC as unknown as StrategyDefinition['defaults'],
  bounds: {
    swingLength: { min: 3, max: 12, step: 1 },
    fvgLookback: { min: 4, max: 30, step: 2 },
    volumePeriod: { min: 10, max: 40, step: 5 },
    minRelativeVolume: { min: 0.8, max: 2.5, step: 0.1 },
    atrPeriod: { min: 7, max: 28, step: 1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 4, step: 0.25 },
    stopBufferAtr: { min: 0, max: 1, step: 0.05 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('SMC_STRUCTURE', new SmcProfile(clampParams(SMC_STRUCTURE, params) as unknown as SmcParams));
  },
};

export const SMC_STRUCTURE_15M: StrategyDefinition = {
  id: 'SMC_STRUCTURE_15M',
  name: 'Smart Money Structure (15m)',
  style: 'INTRADAY',
  timeframe: '15m',
  description: '15-minute market structure break (BOS/ChoCH + FVG) with >=1.2x volume and wider ATR stop geometry.',
  defaults: {
    ...DEFAULT_SMC,
    swingLength: 3,
    fvgLookback: 6,
    minStopAtr: 0.75,
    stopAtrMultiple: 3,
    targetRR: 2,
  } as unknown as StrategyDefinition['defaults'],
  bounds: SMC_STRUCTURE.bounds,
  create(params) {
    return tagged('SMC_STRUCTURE_15M', new SmcProfile(clampParams(SMC_STRUCTURE_15M, params) as unknown as SmcParams));
  },
};
