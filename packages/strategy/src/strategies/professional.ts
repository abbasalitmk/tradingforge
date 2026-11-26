import type { Signal, Side, TradingStyle } from '@tradeforger/core';
import { closes, latest, ema, atr, adx } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import {
  intradayFrame, sessionVwap, priorSession, dayLevels, avgVolume, clampStop, riskGeometry, buildSignal, closeLocation, fmt,
} from './common.ts';

/*
 * Setups from the audit checklist that the catalog lacked. Each signals
 * on a CLOSED bar that has already broken its trigger, because the engine
 * enters at that close (the next bar's open in backtests), never on a resting
 * stop order.
 */

// ─────────────────────────────── Holy Grail ───────────────────────────────

export interface HolyGrailParams {
  readonly atrPeriod: number;
  readonly emaPeriod: number;
  /** ADX(14) the trend needs — Raschke's original is 30. */
  readonly minAdx: number;
  /** Bars back the pullback to the EMA may have touched it. */
  readonly touchBars: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_HOLY_GRAIL: HolyGrailParams = {
  atrPeriod: 14,
  emaPeriod: 20,
  minAdx: 30,
  touchBars: 3,
  stopBufferAtr: 0.1,
  minStopAtr: 0.75,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * Linda Raschke's Holy Grail: in a strong trend (ADX ≥ 30, DI lines agreeing)
 * price pulls back to the 20-EMA, and the first bar to break the pullback
 * bar's extreme resumes the trend. Stop beyond the pullback's swing.
 */
export class HolyGrailProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Holy Grail Pullback';
  readonly warmupBars: number;
  private readonly p: HolyGrailParams;

  constructor(params: HolyGrailParams = DEFAULT_HOLY_GRAIL) {
    this.p = params;
    this.warmupBars = Math.max(params.emaPeriod, params.atrPeriod) * 3;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, last } = frame;
    const p = this.p;
    const n = candles.length;
    const e = ema(closes(candles), p.emaPeriod);
    const dx = adx(candles, 14);
    // The trend is judged on the bar before the trigger: the pullback is what weakens it.
    const [adxPrev, pdi, mdi] = [dx.adx[n - 2], dx.plusDi[n - 2], dx.minusDi[n - 2]];
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (adxPrev == null || pdi == null || mdi == null || atrNow === null || atrNow <= 0) return null;
    if (adxPrev < p.minAdx) return null;
    const side: Side = pdi > mdi ? 'BUY' : 'SELL';
    const long = side === 'BUY';
    const dir = long ? 1 : -1;

    const pull = candles[n - 2]!;
    // A pullback bar (or one just before it) reached the EMA from the trend side.
    let touched = false;
    for (let k = 2; k <= p.touchBars + 1 && n - k >= 0; k++) {
      const b = candles[n - k]!;
      const ev = e[n - k];
      if (ev == null) continue;
      if (long ? b.low <= ev && b.close >= ev * 0.998 : b.high >= ev && b.close <= ev * 1.002) touched = true;
    }
    if (!touched) return null;
    if (long ? last.close <= pull.high : last.close >= pull.low) return null;
    const eNow = e[n - 1];
    if (eNow == null || (last.close - eNow) * dir <= 0) return null;

    const swingBars = candles.slice(-(p.touchBars + 1), -1);
    const swing = long ? Math.min(...swingBars.map((b) => b.low)) : Math.max(...swingBars.map((b) => b.high));
    const price = last.close;
    const vw = sessionVwap(session)[session.length - 1]!;
    const checks: Confluence[] = [
      { name: 'strongTrend', passed: adxPrev >= p.minAdx + 5, weight: 2, detail: `ADX ${fmt(adxPrev, 1)} (≥ ${p.minAdx} required)` },
      { name: 'vwapSide', passed: (price - vw) * dir > 0, weight: 2, detail: `${long ? 'Above' : 'Below'} session VWAP` },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Trigger bar closed near its extreme' },
      { name: 'volume', passed: last.volume > pull.volume, weight: 1, detail: 'Trigger volume above the pullback bar' },
    ];
    const confidence = Math.round(50 + scoreConfluence(checks) / 2);
    if (confidence < p.minConfidence) return null;

    const stopDistance = clampStop((price - swing) * dir + p.stopBufferAtr * atrNow, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;
    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence,
      checks: [{ name: 'holyGrail', passed: true, weight: 0, detail: `ADX ${fmt(adxPrev, 1)} pullback to EMA${p.emaPeriod}, broke the pullback bar` }, ...checks],
      indicators: { atr: atrNow, adx: adxPrev, ema: eNow, swing, vwap: vw, triggerPrice: long ? pull.high : pull.low },
    });
  }
}

const HOLY_GRAIL_BOUNDS = {
  minAdx: { min: 20, max: 40, step: 1 },
  touchBars: { min: 1, max: 6, step: 1 },
  stopBufferAtr: { min: 0, max: 1, step: 0.1 },
  minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
  maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
  targetRR: { min: 1.2, max: 4, step: 0.25 },
  minConfidence: { min: 50, max: 90, step: 5 },
};

export const HOLY_GRAIL_15M: StrategyDefinition = {
  id: 'HOLY_GRAIL_15M',
  name: 'Holy Grail Pullback (15m)',
  style: 'INTRADAY',
  timeframe: '15m',
  description: 'Raschke: ADX ≥ 30 trend, pullback to the 20-EMA, enter when a closed 15-min bar breaks the pullback bar; stop beyond the pullback swing.',
  defaults: DEFAULT_HOLY_GRAIL as unknown as StrategyDefinition['defaults'],
  bounds: HOLY_GRAIL_BOUNDS,
  create(params) {
    return tagged('HOLY_GRAIL_15M', new HolyGrailProfile(clampParams(HOLY_GRAIL_15M, params) as unknown as HolyGrailParams));
  },
};

// ─────────────────────────────── Inside bar at a key level ───────────────────────────────

export interface InsideBarParams {
  readonly atrPeriod: number;
  /** The inside bar must sit within this many ATRs of PDH, PDL or VWAP. */
  readonly levelAtr: number;
  readonly minVolumeRatio: number;
  readonly volumePeriod: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minConfidence: number;
}

export const DEFAULT_INSIDE_BAR: InsideBarParams = {
  atrPeriod: 14,
  levelAtr: 0.5,
  minVolumeRatio: 1.2,
  volumePeriod: 20,
  minStopAtr: 0.75,
  maxStopAtr: 2.5,
  targetRR: 2,
  minConfidence: 60,
};

/**
 * Inside-bar breakout at a key level (Al Brooks style price action): a
 * mother bar, a smaller bar fully inside it near yesterday's high/low or
 * session VWAP — compression at a level traders watch — then a close beyond
 * the mother bar on volume. Stop at the mother bar's other end.
 */
export class InsideBarProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'Inside Bar at Key Level';
  readonly warmupBars: number;
  private readonly p: InsideBarParams;

  constructor(params: InsideBarParams = DEFAULT_INSIDE_BAR) {
    this.p = params;
    this.warmupBars = Math.max(params.atrPeriod, params.volumePeriod) + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, session, sessionStart, last } = frame;
    const p = this.p;
    const n = candles.length;
    if (session.length < 3) return null;
    const mother = candles[n - 3]!;
    const inside = candles[n - 2]!;
    if (!(inside.high <= mother.high && inside.low >= mother.low)) return null;
    let side: Side;
    if (last.close > mother.high) side = 'BUY';
    else if (last.close < mother.low) side = 'SELL';
    else return null;
    const long = side === 'BUY';
    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const prev = dayLevels(priorSession(candles, sessionStart));
    const vw = sessionVwap(session)[session.length - 2]!;
    const mid = (inside.high + inside.low) / 2;
    const near = [prev?.high, prev?.low, vw].filter((x): x is number => x != null)
      .some((lv) => Math.abs(mid - lv) <= p.levelAtr * atrNow);
    if (!near) return null;
    const avg = avgVolume(candles, n - 1, p.volumePeriod);
    const volRatio = avg ? last.volume / avg : 0;
    if (volRatio < p.minVolumeRatio) return null;

    const price = last.close;
    const dir = long ? 1 : -1;
    const vwNow = sessionVwap(session)[session.length - 1]!;
    const checks: Confluence[] = [
      { name: 'vwapSide', passed: (price - vwNow) * dir > 0, weight: 2, detail: `${long ? 'Above' : 'Below'} session VWAP` },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Breakout bar closed near its extreme' },
      { name: 'tightInside', passed: inside.high - inside.low <= 0.6 * (mother.high - mother.low), weight: 1, detail: 'Inside bar well inside the mother bar' },
    ];
    const confidence = Math.round(50 + scoreConfluence(checks) / 2);
    if (confidence < p.minConfidence) return null;

    const stopDistance = clampStop((price - (long ? mother.low : mother.high)) * dir, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;
    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence,
      checks: [{ name: 'insideBreak', passed: true, weight: 0, detail: `Inside bar at a key level broke the mother bar on ${fmt(volRatio)}x volume` }, ...checks],
      indicators: { atr: atrNow, motherHigh: mother.high, motherLow: mother.low, vwap: vwNow, volRatio, triggerPrice: long ? mother.high : mother.low },
    });
  }
}

export const INSIDE_BAR_15M: StrategyDefinition = {
  id: 'INSIDE_BAR_15M',
  name: 'Inside Bar at Key Level (15m)',
  style: 'INTRADAY',
  timeframe: '15m',
  description: 'A 15-min inside bar near PDH, PDL or VWAP, then a close beyond the mother bar on 1.2x volume; stop at the mother bar\'s other end.',
  defaults: DEFAULT_INSIDE_BAR as unknown as StrategyDefinition['defaults'],
  bounds: {
    levelAtr: { min: 0.2, max: 1.5, step: 0.1 },
    minVolumeRatio: { min: 0.8, max: 2.5, step: 0.1 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minConfidence: { min: 50, max: 90, step: 5 },
  },
  create(params) {
    return tagged('INSIDE_BAR_15M', new InsideBarProfile(clampParams(INSIDE_BAR_15M, params) as unknown as InsideBarParams));
  },
};
