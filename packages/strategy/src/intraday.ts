import {
  type Candle, type Signal, type TradingStyle, type Paise,
  newSignalId, rupeesToPaise, istMinutes, SESSION,
} from '@tradeforger/core';
import {
  closes, latest, prior, ema, atr, supertrend, adx,
  rsi, vwap, relativeVolume, openingRange, orbState,
} from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence,
  scoreConfluence, passedNames,
} from './profile.ts';

export interface IntradayParams {
  readonly orbMinutes: number;
  readonly atrPeriod: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minRelativeVolume: number;
  readonly minAdx: number;
  readonly rsiUpper: number;
  readonly rsiLower: number;
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
  rsiUpper: 70,
  rsiLower: 30,
  minConfidence: 65,
};

/**
 * Intraday equity profile — the only profile live in v1.
 *
 * Entry is an Opening Range Breakout confirmed by four independent things:
 * trend (Supertrend + EMA), strength (ADX), participation (relative volume),
 * and location (VWAP side). Requiring agreement across categories rather than
 * stacking correlated momentum indicators is what keeps the signal count low
 * enough that costs do not eat the edge.
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
    const price = last.close;
    const c = closes(candles);

    const range = openingRange(candles, this.p.orbMinutes);
    if (!range || !range.complete) return null;

    const state = orbState(range, price);
    if (state === 'INSIDE') return null;
    const side = state === 'ABOVE' ? 'BUY' : 'SELL';

    const atrSeries = atr(candles, this.p.atrPeriod);
    const atrNow = latest(atrSeries);
    if (atrNow === null || atrNow <= 0) return null;

    const st = supertrend(candles, 10, 3);
    const stDir = st.direction[st.direction.length - 1];
    const ema9 = latest(ema(c, 9));
    const ema21 = latest(ema(c, 21));
    const adxNow = latest(adx(candles, 14).adx);
    const rsiNow = latest(rsi(c, 14));
    const vwapNow = latest(vwap(candles));
    const rvol = latest(relativeVolume(candles, 20));

    const long = side === 'BUY';
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
        passed: rvol !== null && rvol >= this.p.minRelativeVolume,
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
        // Momentum confirmation, but NOT already exhausted. Entering a long at
        // RSI 85 is buying the top of the move that other people are exiting.
        name: 'rsi',
        passed: rsiNow !== null && (long
          ? rsiNow > 50 && rsiNow < this.p.rsiUpper + 15
          : rsiNow < 50 && rsiNow > this.p.rsiLower - 15),
        weight: 1,
        detail: `RSI ${rsiNow?.toFixed(1) ?? 'n/a'}`,
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
        rsi: rsiNow ?? 0,
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
