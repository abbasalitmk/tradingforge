import {
  type Candle, type Signal, type TradingStyle, type Paise,
  newSignalId, rupeesToPaise, istMinutes, istDateKey, SESSION,
} from '@tradeforger/core';
import {
  closes, latest, ema, atr, supertrend, adx,
  rsi, vwap, relativeVolume, openingRange, orbState,
} from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence,
  scoreConfluence, passedNames,
} from './profile.ts';
import { type StrategyDefinition, type Params, tagged, clampParams } from './definition.ts';

export interface IntradayParams {
  readonly orbMinutes: number;
  readonly atrPeriod: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minRelativeVolume: number;
  readonly minAdx: number;
  readonly rsiUpper: number;
  readonly rsiLower: number;
  /** Maximum consecutive closed bars outside the opening range (0 = unlimited). */
  readonly freshBars: number;
  /** Minimum confluence score to emit a signal at all. */
  readonly minConfidence: number;
}

export const DEFAULT_INTRADAY: IntradayParams = {
  orbMinutes: 15,
  atrPeriod: 14,
  stopAtrMultiple: 1.5,
  targetRR: 2,
  minRelativeVolume: 1.5,
  minAdx: 20,
  rsiUpper: 72,
  rsiLower: 28,
  freshBars: 5,
  minConfidence: 65,
};

/**
 * Intraday equity profile — the only profile live in v1.
 *
 * Entry is an Opening Range Breakout confirmed by four independent things:
 * trend (Supertrend + EMA), strength (ADX), participation (relative volume),
 * and location (VWAP side). Hard exhaustion (RSI), participation (RVOL) and
 * freshness gates block late overbought chases (e.g. RSI > 72 or 90-min stale).
 *
 * A breakout is only taken once the opening range is CLOSED. Trading a range
 * that is still forming means breaking out of a level that is still moving.
 */
export class IntradayProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'ORB + Supertrend + VWAP';
  readonly warmupBars: number;
  private readonly p: IntradayParams;

  constructor(params: IntradayParams = DEFAULT_INTRADAY) {
    this.p = params;
    this.warmupBars = Math.max(params.atrPeriod, 26) + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const { candles } = ctx;
    if (candles.length < this.warmupBars) return null;

    const now = ctx.clock.now();
    const mins = istMinutes(now);
    if (mins < SESSION.ENTRY_START || mins >= SESSION.ENTRY_END) return null;

    const last = candles[candles.length - 1]!;
    const todayKey = istDateKey(now);
    // Warmup history spans prior sessions; before today's first bar exists the
    // last bar is yesterday's close, and its breakout is not today's trade.
    if (istDateKey(new Date(last.ts)) !== todayKey) return null;
    const price = last.close;
    const c = closes(candles);

    const range = openingRange(candles, this.p.orbMinutes);
    if (!range || !range.complete) return null;

    const state = orbState(range, price);
    if (state === 'INSIDE') return null;
    const side = state === 'ABOVE' ? 'BUY' : 'SELL';
    const long = side === 'BUY';

    // Freshness gate: only accept an ORB breakout while the current move outside
    // the opening range is fresh, never 1–2 hours after it already left the range.
    if (this.p.freshBars > 0) {
      const rangeEndMin = SESSION.OPEN + this.p.orbMinutes;
      let streak = 0;
      for (let i = candles.length - 1; i >= 0; i--) {
        const bar = candles[i]!;
        const d = new Date(bar.ts);
        if (istDateKey(d) !== todayKey || istMinutes(d) < rangeEndMin) break;
        if (orbState(range, bar.close) !== state) break;
        streak++;
        if (streak > this.p.freshBars) return null;
      }
    }

    const atrSeries = atr(candles, this.p.atrPeriod);
    const atrNow = latest(atrSeries);
    if (atrNow === null || atrNow <= 0) return null;

    const rsiNow = latest(rsi(c, 14));
    // Hard exhaustion gate: refuse vertical moves already overbought/oversold.
    if (rsiNow === null || (long ? rsiNow >= this.p.rsiUpper : rsiNow <= this.p.rsiLower)) return null;

    const rvol = latest(relativeVolume(candles, 20));
    // Hard participation gate: low-volume ORB pokes reverse frequently.
    if (this.p.minRelativeVolume > 0 && (rvol === null || rvol < this.p.minRelativeVolume)) return null;

    const st = supertrend(candles, 10, 3);
    const stDir = st.direction[st.direction.length - 1];
    const ema9 = latest(ema(c, 9));
    const ema21 = latest(ema(c, 21));
    const adxNow = latest(adx(candles, 14).adx);
    const vwapNow = latest(vwap(candles));

    const checks: Confluence[] = [
      {
        name: 'orb',
        passed: true,
        weight: 3,
        detail: `ORB ${state} (${range.low.toFixed(2)}–${range.high.toFixed(2)})`,
      },
      {
        name: 'supertrend',
        passed: stDir === (long ? 1 : -1),
        weight: 3,
        detail: `Supertrend ${stDir === 1 ? 'up' : 'down'}`,
      },
      {
        name: 'ema',
        passed: ema9 !== null && ema21 !== null && (long ? ema9 > ema21 : ema9 < ema21),
        weight: 2,
        detail: `EMA9 ${long ? '>' : '<'} EMA21`,
      },
      {
        name: 'adx',
        passed: adxNow !== null && adxNow >= this.p.minAdx,
        weight: 2,
        detail: `ADX ${adxNow?.toFixed(1) ?? 'n/a'}`,
      },
      {
        name: 'volume',
        passed: true,
        weight: 3,
        detail: `RVOL ${rvol?.toFixed(2) ?? 'n/a'}x`,
      },
      {
        name: 'vwap',
        passed: vwapNow !== null && (long ? price > vwapNow : price < vwapNow),
        weight: 2,
        detail: `price ${long ? 'above' : 'below'} VWAP`,
      },
      {
        name: 'rsi',
        passed: long ? rsiNow > 50 : rsiNow < 50,
        weight: 1,
        detail: `RSI ${rsiNow.toFixed(1)}`,
      },
      {
        // Breakout must be decisive, not a wick poking through the level.
        name: 'closeBeyond',
        passed: long ? last.close > range.high : last.close < range.low,
        weight: 2,
        detail: 'closed beyond the range',
      },
    ];

    const confidence = scoreConfluence(checks);
    if (confidence < this.p.minConfidence) return null;

    const stopDistance = atrNow * this.p.stopAtrMultiple;
    const entry = rupeesToPaise(price);
    const stopLoss = rupeesToPaise(long ? price - stopDistance : price + stopDistance);
    const target = rupeesToPaise(
      long
        ? price + stopDistance * this.p.targetRR
        : price - stopDistance * this.p.targetRR,
    );

    return {
      id: newSignalId(),
      instrumentKey: ctx.instrumentKey,
      symbol: ctx.symbol,
      style: this.style,
      side,
      entry,
      stopLoss,
      target,
      atr: atrNow,
      confidence,
      reasons: passedNames(checks),
      indicators: {
        atr: atrNow,
        adx: adxNow ?? 0,
        rsi: rsiNow,
        vwap: vwapNow ?? 0,
        rvol: rvol ?? 0,
        ema9: ema9 ?? 0,
        ema21: ema21 ?? 0,
        orbHigh: range.high,
        orbLow: range.low,
        supertrend: st.value[st.value.length - 1] ?? 0,
      },
      generatedAt: ctx.clock.ms(),
    } satisfies Signal;
  }
}

export const ORB_SUPERTREND_15M: StrategyDefinition = {
  id: 'ORB_SUPERTREND_15M',
  name: 'ORB + Supertrend + VWAP (15m)',
  style: 'INTRADAY',
  timeframe: '15m',
  description: '15-minute bar ORB breakout confirmed by Supertrend, EMA9/21, ADX, >=1.4x RVOL, VWAP side and fresh RSI room (<72 / >28).',
  defaults: {
    ...DEFAULT_INTRADAY,
    minRelativeVolume: 1.4,
    freshBars: 2,
    stopAtrMultiple: 1.5,
    targetRR: 2,
  } as unknown as Params,
  bounds: {
    orbMinutes: { min: 15, max: 30, step: 15 },
    stopAtrMultiple: { min: 1, max: 3, step: 0.25 },
    targetRR: { min: 1.2, max: 3.5, step: 0.25 },
    minRelativeVolume: { min: 1, max: 3, step: 0.2 },
    minAdx: { min: 12, max: 35, step: 1 },
    rsiUpper: { min: 62, max: 85, step: 2 },
    rsiLower: { min: 15, max: 38, step: 2 },
    freshBars: { min: 1, max: 8, step: 1 },
    minConfidence: { min: 50, max: 90, step: 5 },
  },
  create(params) {
    return tagged(this.id, new IntradayProfile(clampParams(this, params) as unknown as IntradayParams));
  },
};

/** Trailing stop: only ever moves in the favourable direction. */
export function trailStop(
  side: 'BUY' | 'SELL',
  currentStop: Paise,
  price: Paise,
  atrValue: number,
  multiple: number,
): Paise {
  const gap = rupeesToPaise(atrValue * multiple);
  const candidate = (side === 'BUY' ? price - gap : price + gap) as Paise;
  // A stop that can loosen is not a stop.
  return (side === 'BUY'
    ? Math.max(currentStop, candidate)
    : Math.min(currentStop, candidate)) as Paise;
}
