import {
  type Candle, type Signal, type TradingStyle, type Paise,
  newSignalId, rupeesToPaise,
} from '@tradeforger/core';
import {
  closes, latest, prior, ema, atr, macd, adx,
  rsi, relativeVolume, findLevels,
} from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence,
  scoreConfluence, passedNames,
} from './profile.ts';

export interface SwingParams {
  readonly emaFastPeriod: number;
  readonly emaSlowPeriod: number;
  readonly atrPeriod: number;
  readonly stopAtrMultiple: number;
  readonly targetRR: number;
  readonly minRelativeVolume: number;
  readonly minAdx: number;
  readonly rsiMin: number;
  readonly rsiMax: number;
  readonly minConfidence: number;
}

export const DEFAULT_SWING: SwingParams = {
  emaFastPeriod: 20,
  emaSlowPeriod: 50,
  atrPeriod: 14,
  stopAtrMultiple: 2.5,
  targetRR: 2.5,
  minRelativeVolume: 1.0,
  minAdx: 18,
  rsiMin: 40,
  rsiMax: 65,
  minConfidence: 65,
};

/**
 * Swing equity profile.
 *
 * Designed for multi-day position holding using daily or multi-hour candles.
 * Focuses on high-expectancy trend pullbacks:
 *  - Primary trend defined by EMA20 / EMA50 alignment
 *  - Pullback to value zone near EMA20 or horizontal pivot S/R
 *  - Momentum confirmation via MACD expansion and RSI in prime acceleration zone
 *  - Volume expansion confirming institutional participation
 *  - Wide volatility-based stops (2.5x ATR) to withstand intraday noise
 *  - Product type is 'D' (Delivery/CNC) — positions survive across sessions
 */
export class SwingProfile implements StrategyProfile {
  readonly style: TradingStyle = 'SWING';
  readonly name = 'EMA Trend + MACD + RSI Pullback';
  readonly warmupBars: number;
  private readonly p: SwingParams;

  constructor(params: SwingParams = DEFAULT_SWING) {
    this.p = params;
    this.warmupBars = Math.max(params.emaSlowPeriod, params.atrPeriod, 50) + 10;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const { candles } = ctx;
    if (candles.length < this.warmupBars) return null;

    const last = candles[candles.length - 1]!;
    const price = last.close;
    const c = closes(candles);

    const atrSeries = atr(candles, this.p.atrPeriod);
    const atrNow = latest(atrSeries);
    if (atrNow === null || atrNow <= 0) return null;

    const emaFast = latest(ema(c, this.p.emaFastPeriod));
    const emaSlow = latest(ema(c, this.p.emaSlowPeriod));
    if (emaFast === null || emaSlow === null) return null;

    const adxNow = latest(adx(candles, 14).adx);
    if (adxNow === null || adxNow < this.p.minAdx) return null;

    // Minimum EMA separation to ensure active trend rather than intertwined chop
    const emaSep = Math.abs(emaFast - emaSlow) / emaSlow;
    if (emaSep < 0.003) return null;

    // Trend direction determined by EMA alignment
    const isBullTrend = emaFast > emaSlow;
    const isBearTrend = emaFast < emaSlow;
    if (!isBullTrend && !isBearTrend) return null;

    const side = isBullTrend ? 'BUY' : 'SELL';
    const long = side === 'BUY';

    const macdRes = macd(c, 12, 26, 9);
    const macdHist = latest(macdRes.histogram);
    const macdHistPrior = prior(macdRes.histogram, 1);
    const rsiNow = latest(rsi(c, 14));
    const rvol = latest(relativeVolume(candles, 20));

    // Support and Resistance pivots
    const levels = findLevels(candles, 3, 0.015);
    const nearbyLevel = long
      ? levels.support.find((s) => Math.abs(price - s.price) / price <= 0.02)
      : levels.resistance.find((r) => Math.abs(price - r.price) / price <= 0.02);

    // Pullback proximity check: price within 2.5% of EMA fast
    const emaDistancePct = Math.abs(price - emaFast) / price;
    const nearEma = emaDistancePct <= 0.035;

    // MACD momentum: expanding in trend direction
    const macdAligned = long
      ? (macdHist !== null && macdHist > 0) || (macdHist !== null && macdHistPrior !== null && macdHist > macdHistPrior)
      : (macdHist !== null && macdHist < 0) || (macdHist !== null && macdHistPrior !== null && macdHist < macdHistPrior);

    // RSI criteria: healthy momentum, not exhausted
    const rsiValid = rsiNow !== null && (long
      ? rsiNow >= this.p.rsiMin && rsiNow <= this.p.rsiMax
      : rsiNow >= (100 - this.p.rsiMax) && rsiNow <= (100 - this.p.rsiMin));

    const checks: Confluence[] = [
      {
        name: 'trend_ema',
        passed: long ? emaFast > emaSlow && price > emaSlow : emaFast < emaSlow && price < emaSlow,
        weight: 3,
        detail: `EMA${this.p.emaFastPeriod} ${long ? '>' : '<'} EMA${this.p.emaSlowPeriod} trend aligned`,
      },
      {
        name: 'pullback_zone',
        passed: nearEma,
        weight: 3,
        detail: `Price near EMA${this.p.emaFastPeriod} (${(emaDistancePct * 100).toFixed(1)}% distance)`,
      },
      {
        name: 'macd_momentum',
        passed: macdAligned,
        weight: 2,
        detail: `MACD histogram ${macdHist && macdHist > 0 ? 'bullish' : 'bearish'} expansion`,
      },
      {
        name: 'rsi_acceleration',
        passed: rsiValid,
        weight: 2,
        detail: `RSI ${rsiNow?.toFixed(1) ?? 'n/a'} in optimal swing zone`,
      },
      {
        name: 'adx_trend_strength',
        passed: adxNow !== null && adxNow >= this.p.minAdx,
        weight: 1,
        detail: `ADX ${adxNow?.toFixed(1) ?? 'n/a'} >= ${this.p.minAdx}`,
      },
      {
        name: 'volume_participation',
        passed: rvol !== null && rvol >= this.p.minRelativeVolume,
        weight: 2,
        detail: `RVOL ${rvol?.toFixed(2) ?? 'n/a'}x`,
      },
      {
        name: 'pivot_confluence',
        passed: nearbyLevel !== undefined,
        weight: 2,
        detail: nearbyLevel
          ? `Near pivot ${long ? 'support' : 'resistance'} ₹${nearbyLevel.price.toFixed(2)} (${nearbyLevel.touches} touches)`
          : 'No immediate pivot confluence',
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
        triggerPrice: Number((long ? last.high + 0.05 : last.low - 0.05).toFixed(2)),
        emaFast,
        emaSlow,
        rsi: rsiNow ?? 0,
        macdHist: macdHist ?? 0,
        adx: adxNow ?? 0,
        rvol: rvol ?? 0,
        pivotLevel: nearbyLevel?.price ?? 0,
      },
      generatedAt: ctx.clock.ms(),
    } satisfies Signal;
  }
}
