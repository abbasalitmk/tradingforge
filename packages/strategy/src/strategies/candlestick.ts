import type { Candle, Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, ema, atr, rsi } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { visibleCandles, clampStop, riskGeometry, buildSignal, fmt } from './common.ts';

export interface CandlestickParams {
  /** Body ≤ this share of the range reads as a doji / indecision. */
  readonly dojiBodyPct: number;
  /** Shadow must be at least this many bodies long for hammers and stars. */
  readonly shadowRatio: number;
  readonly trendPeriod: number;
  readonly pullbackPeriod: number;
  readonly volumePeriod: number;
  readonly atrPeriod: number;
  readonly minStopAtr: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  /** 0/1. Equity delivery cannot be held short overnight in India, so off by default. */
  readonly allowShort: number;
  readonly minConfidence: number;
  /** Engulfing, piercing and soldier/crow bodies must be at least this many ATRs. */
  readonly minBodyAtr: number;
}

export const DEFAULT_CANDLESTICK: CandlestickParams = {
  dojiBodyPct: 0.1,
  shadowRatio: 2,
  trendPeriod: 50,
  pullbackPeriod: 20,
  volumePeriod: 20,
  atrPeriod: 14,
  minStopAtr: 0.5,
  stopAtrMultiple: 2,
  targetRR: 2,
  allowShort: 0,
  minConfidence: 75,
  minBodyAtr: 0.3,
};

const body = (c: Candle): number => Math.abs(c.close - c.open);
const range = (c: Candle): number => c.high - c.low;
const bull = (c: Candle): boolean => c.close > c.open;
const bear = (c: Candle): boolean => c.close < c.open;
const upper = (c: Candle): number => c.high - Math.max(c.open, c.close);
const lower = (c: Candle): number => Math.min(c.open, c.close) - c.low;
const mid = (c: Candle): number => (c.open + c.close) / 2;

/**
 * Patterns completing on the last bar, as names per side. `falling`/`rising`
 * is the short-term move into the pattern: a hammer is only a hammer after a
 * decline, the same shape after a rally is a hanging man.
 */
export function detectPatterns(
  c: readonly Candle[], p: Pick<CandlestickParams, 'dojiBodyPct' | 'shadowRatio'>, falling: boolean, rising: boolean,
  minBody = 0,
): { bullish: string[]; bearish: string[] } {
  const bullish: string[] = [], bearish: string[] = [];
  const n = c.length;
  if (n < 3) return { bullish, bearish };
  const a = c[n - 3]!, b = c[n - 2]!, x = c[n - 1]!;
  // A star's body only needs to be small, not a true doji.
  const small = (k: Candle) => range(k) > 0 && body(k) <= p.dojiBodyPct * range(k) * 3;
  // Multi-bar patterns made of tiny candles are noise, not conviction.
  const real = (k: Candle) => body(k) >= minBody;

  // Single candle
  if (range(x) > 0 && body(x) > 0) {
    if (falling && lower(x) >= p.shadowRatio * body(x) && upper(x) <= body(x)) bullish.push('Hammer');
    if (falling && upper(x) >= p.shadowRatio * body(x) && lower(x) <= body(x)) bullish.push('Inverted hammer');
    if (rising && upper(x) >= p.shadowRatio * body(x) && lower(x) <= body(x)) bearish.push('Shooting star');
  }

  // Two candles
  if (bear(b) && bull(x) && real(x) && x.close >= b.open && x.open <= b.close && body(x) > body(b)) bullish.push('Bullish engulfing');
  if (bull(b) && bear(x) && real(x) && x.close <= b.open && x.open >= b.close && body(x) > body(b)) bearish.push('Bearish engulfing');
  if (bear(b) && bull(x) && x.open >= b.close && x.close <= b.open && body(x) < body(b) * 0.6) bullish.push('Bullish harami');
  if (bull(b) && bear(x) && x.open <= b.close && x.close >= b.open && body(x) < body(b) * 0.6) bearish.push('Bearish harami');
  if (bear(b) && real(b) && bull(x) && x.open <= b.close && x.close > mid(b) && x.close < b.open) bullish.push('Piercing line');
  if (bull(b) && real(b) && bear(x) && x.open >= b.close && x.close < mid(b) && x.close > b.open) bearish.push('Dark cloud cover');

  // Three candles
  if (bear(a) && small(b) && bull(x) && x.close > mid(a)) bullish.push('Morning star');
  if (bull(a) && small(b) && bear(x) && x.close < mid(a)) bearish.push('Evening star');
  if (bull(a) && bull(b) && bull(x) && real(a) && real(b) && real(x) && b.close > a.close && x.close > b.close && b.open >= a.open && x.open >= b.open) {
    bullish.push('Three white soldiers');
  }
  if (bear(a) && bear(b) && bear(x) && real(a) && real(b) && real(x) && b.close < a.close && x.close < b.close && b.open <= a.open && x.open <= b.open) {
    bearish.push('Three black crows');
  }
  return { bullish, bearish };
}

/**
 * Candlestick patterns, daily (after Vibe-Trading's `candlestick` skill).
 *
 * The skill nets bullish against bearish patterns; on their own those are
 * coin flips. Here a pattern is only traded where it means something — at the
 * end of a pullback inside an established trend — so the trend and the
 * pullback carry the most weight: at the default threshold a pattern reaches
 * it only with both, whatever else agrees.
 */
export class CandlestickProfile implements StrategyProfile {
  readonly style: TradingStyle = 'SWING';
  readonly name = 'Candlestick Patterns';
  readonly warmupBars: number;
  private readonly p: CandlestickParams;

  constructor(params: CandlestickParams = DEFAULT_CANDLESTICK) {
    this.p = params;
    this.warmupBars = Math.max(params.trendPeriod + 6, params.pullbackPeriod + 6, params.volumePeriod + 2, params.atrPeriod * 2);
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const p = this.p;
    const candles = visibleCandles(ctx.candles, ctx.clock.ms());
    const n = candles.length;
    if (n < this.warmupBars) return null;

    const c = closes(candles);
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;
    const recent = c.slice(n - 6, n - 1);
    const falling = recent.length === 5 && recent[4]! < recent[0]!;
    const rising = recent.length === 5 && recent[4]! > recent[0]!;
    const { bullish, bearish } = detectPatterns(candles, p, falling, rising, p.minBodyAtr * atrNow);
    const net = bullish.length - bearish.length;

    let side: Side;
    if (net > 0) side = 'BUY';
    else if (net < 0 && p.allowShort >= 1) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const dir = long ? 1 : -1;
    const patterns = long ? bullish : bearish;

    const last = candles[n - 1]!;
    const price = last.close;
    const trend = ema(c, p.trendPeriod);
    const tNow = trend[n - 1] ?? null;
    const tThen = trend[n - 6] ?? null;
    const pull = ema(c, p.pullbackPeriod);
    const pNow = pull[n - 1] ?? null;
    const swingExtreme = long
      ? Math.min(...candles.slice(n - 3).map((k) => k.low))
      : Math.max(...candles.slice(n - 3).map((k) => k.high));
    const rsiNow = latest(rsi(c, 14));
    const vols = candles.slice(n - 1 - p.volumePeriod, n - 1).map((k) => k.volume);
    const avgVol = vols.reduce((a, b) => a + b, 0) / Math.max(1, vols.length);
    const volRatio = avgVol > 0 ? last.volume / avgVol : 0;

    const checks: Confluence[] = [
      { name: 'pattern', passed: true, weight: 3, detail: patterns.join(' + ') },
      {
        name: 'trend', passed: tNow !== null && tThen !== null && (price - tNow) * dir > 0 && (tNow - tThen) * dir > 0,
        weight: 4,
        detail: `With the EMA${p.trendPeriod} trend`,
      },
      {
        // The pattern formed where a pullback in the trend would end: near the faster EMA.
        name: 'pullback', passed: pNow !== null && Math.abs(swingExtreme - pNow) <= atrNow, weight: 4,
        detail: `Pattern formed at the EMA${p.pullbackPeriod} pullback zone`,
      },
      { name: 'confluence', passed: patterns.length >= 2, weight: 1, detail: 'More than one pattern agrees' },
      { name: 'volume', passed: volRatio >= 1, weight: 1, detail: `Volume ${volRatio.toFixed(2)}x average` },
      {
        name: 'rsiRoom', passed: rsiNow !== null && (long ? rsiNow < 70 : rsiNow > 30), weight: 1,
        detail: `RSI ${fmt(rsiNow, 1)} not ${long ? 'overbought' : 'oversold'}`,
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const structural = (price - swingExtreme) * dir + 0.1 * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.stopAtrMultiple);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: {
        atr: atrNow,
        patterns: patterns.length,
        trendEma: tNow ?? 0,
        pullbackEma: pNow ?? 0,
        rsi: rsiNow ?? 0,
        volumeRatio: volRatio,
      },
    });
  }
}

export const CANDLESTICK_PATTERNS: StrategyDefinition = {
  id: 'CANDLESTICK_PATTERNS',
  name: 'Candlestick Patterns (trend pullback)',
  style: 'SWING',
  timeframe: '1d',
  description: '15 classic daily candlestick patterns, traded only at a pullback inside the EMA50 trend; stop beyond the pattern extreme.',
  defaults: DEFAULT_CANDLESTICK as unknown as StrategyDefinition['defaults'],
  bounds: {
    dojiBodyPct: { min: 0.05, max: 0.2, step: 0.05 },
    shadowRatio: { min: 1.5, max: 3, step: 0.25 },
    trendPeriod: { min: 20, max: 100, step: 10 },
    pullbackPeriod: { min: 10, max: 30, step: 5 },
    volumePeriod: { min: 10, max: 40, step: 5 },
    atrPeriod: { min: 7, max: 28, step: 1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    stopAtrMultiple: { min: 1, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    allowShort: { min: 0, max: 1, step: 1 },
    minConfidence: { min: 40, max: 90, step: 5 },
    minBodyAtr: { min: 0, max: 1, step: 0.1 },
  },
  create(params) {
    return tagged('CANDLESTICK_PATTERNS', new CandlestickProfile(
      clampParams(CANDLESTICK_PATTERNS, params) as unknown as CandlestickParams,
    ));
  },
};
