import {
  type Candle, type Signal, type Side,
  newSignalId, rupeesToPaise, paiseToRupees,
} from '@tradeforger/core';
import {
  closes, latest, ema, atr, supertrend, rsi,
  vwap, relativeVolume, openingRange, orbState,
  adx, bollinger, macd,
} from '@tradeforger/indicators';
import { sessionStartIndex } from './strategies/common.ts';

export interface ScoredStock {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly name: string;
  readonly ltp: number;
  readonly changePct: number;
  readonly volume: number;
  readonly orbStatus: 'ABOVE' | 'BELOW' | 'INSIDE';
  readonly supertrendDir: 'BULLISH' | 'BEARISH';
  readonly rsi: number;
  readonly vwap: number;
  readonly rvol: number;
  readonly atr: number;
  readonly adx?: number;
  readonly strategiesAgreed?: readonly string[];
  readonly score: number; // 0-100 composite ranking score
  readonly rank: number;
  readonly reasons: readonly string[];
  readonly tradeSetup: {
    readonly side: Side;
    readonly entry: number;
    readonly stopLoss: number;
    readonly target1: number; // 1:1.5 RR
    readonly target2: number; // 1:2.5 RR
    readonly trailingGap: number;
    readonly riskPerShare: number;
    readonly rewardToRisk1: number;
    readonly rewardToRisk2: number;
    readonly recommendedShares: (budgetRupees: number) => number;
  } | null;
}

export interface UniverseItem {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly name: string;
}

export interface RankOptions {
  readonly minPrice?: number;
  readonly maxPrice?: number;
}

/**
 * Autonomous Stock Scanner & Multi-Factor Quality Ranker.
 *
 * Scans candidate stocks across the active universe, combining professional
 * quantitative algorithms:
 *  1. 15-min Opening Range Breakout (ORB)
 *  2. Relative Volume Expansion (RVOL)
 *  3. SuperTrend Volatility Bands
 *  4. Institutional VWAP Benchmark
 *  5. RSI Momentum Acceleration Zone
 *  6. ADX Directional Trend Strength Filter
 *  7. Multi-EMA Ribbon / GMMA Trend Alignment
 *  8. Bollinger Band Squeeze & Volatility Expansion
 *  9. MACD Momentum Acceleration Histogram
 * 10. Candlestick Price Action Patterns (Engulfing / Hammer / Star)
 *
 * Ranks stocks from highest to lowest conviction to pinpoint optimal entries.
 */
export class StockScanner {
  rankUniverse(
    universe: readonly UniverseItem[],
    candleMap: ReadonlyMap<string, readonly Candle[]>,
    options?: RankOptions,
  ): ScoredStock[] {
    const scored: Array<Omit<ScoredStock, 'rank'>> = [];

    for (const item of universe) {
      const candles = candleMap.get(item.instrumentKey) ?? [];
      if (candles.length < 15) {
        // Unwarmed or empty candle history
        continue;
      }

      const last = candles[candles.length - 1]!;
      const price = last.close;

      if (options?.minPrice !== undefined && options.minPrice > 0 && price < options.minPrice) {
        continue;
      }
      if (options?.maxPrice !== undefined && options.maxPrice > 0 && options.maxPrice < 500000 && price > options.maxPrice) {
        continue;
      }
      const c = closes(candles);

      const atrVal = latest(atr(candles, 14)) ?? 5.0;
      const rvol = latest(relativeVolume(candles, 20)) ?? 1.0;
      const rsiNow = latest(rsi(c, 14)) ?? 50.0;
      const vwapNow = latest(vwap(candles)) ?? price;
      const st = supertrend(candles, 10, 3);
      const stDir = st.direction[st.direction.length - 1] === 1 ? 'BULLISH' : 'BEARISH';

      const range = openingRange(candles, 15);
      const orb = range ? orbState(range, price) : 'INSIDE';

      const adxRes = adx(candles, 14);
      const adxNow = latest(adxRes.adx) ?? 15.0;

      const bb = bollinger(c, 20, 2);
      const bbUpper = latest(bb.upper);
      const bbLower = latest(bb.lower);

      const ema9 = latest(ema(c, 9));
      const ema21 = latest(ema(c, 21));
      const ema50 = latest(ema(c, 50));

      const m = macd(c, 12, 26, 9);
      const hist = latest(m.histogram) ?? 0;

      let score = 0;
      const reasons: string[] = [];
      const strategiesAgreed: string[] = [];

      // 1. Breakout Quality (Max 25 points) - Pro ORB Algorithm
      if (orb === 'ABOVE') {
        score += 25;
        reasons.push('Decisive 15m ORB Breakout Above');
        strategiesAgreed.push('ORB_BREAKOUT');
      } else if (orb === 'BELOW') {
        score += 25;
        reasons.push('Decisive 15m ORB Breakdown Below');
        strategiesAgreed.push('ORB_BREAKDOWN');
      } else {
        score += 5;
      }

      // 2. Volume Expansion (Max 20 points) - Institutional RVOL
      if (rvol >= 2.2) {
        score += 20;
        reasons.push(`High Institutional Volume (${rvol.toFixed(1)}x RVOL)`);
        strategiesAgreed.push('RVOL_EXPANSION');
      } else if (rvol >= 1.5) {
        score += 14;
        reasons.push(`Above Average Volume (${rvol.toFixed(1)}x RVOL)`);
        strategiesAgreed.push('RVOL_EXPANSION');
      } else if (rvol >= 1.0) {
        score += 8;
      }

      // 3. Trend Alignment (Max 15 points) - SuperTrend Volatility Bands
      const isBullish = orb === 'ABOVE' || (orb === 'INSIDE' && stDir === 'BULLISH');
      if (isBullish && stDir === 'BULLISH') {
        score += 15;
        reasons.push('SuperTrend Bullish Confirmation');
        strategiesAgreed.push('SUPERTREND_MOMENTUM');
      } else if (!isBullish && stDir === 'BEARISH') {
        score += 15;
        reasons.push('SuperTrend Bearish Confirmation');
        strategiesAgreed.push('SUPERTREND_MOMENTUM');
      }

      // 4. VWAP Location (Max 10 points) - Institutional VWAP Benchmark
      if (isBullish && price > vwapNow) {
        score += 10;
        reasons.push('Trading above intraday VWAP benchmark');
        strategiesAgreed.push('VWAP_SUPPORT');
      } else if (!isBullish && price < vwapNow) {
        score += 10;
        reasons.push('Trading below intraday VWAP benchmark');
        strategiesAgreed.push('VWAP_RESISTANCE');
      }

      // 5. RSI Sweet Spot (Max 8 points) - Momentum Acceleration
      if (isBullish && rsiNow >= 55 && rsiNow <= 72) {
        score += 8;
        reasons.push(`RSI ${rsiNow.toFixed(1)} in prime acceleration zone`);
        strategiesAgreed.push('RSI_MOMENTUM');
      } else if (!isBullish && rsiNow <= 45 && rsiNow >= 28) {
        score += 8;
        reasons.push(`RSI ${rsiNow.toFixed(1)} in prime breakdown zone`);
        strategiesAgreed.push('RSI_MOMENTUM');
      }

      // 6. ADX Directional Trend Strength (Max 8 points) - Non-Choppy Trend Filter
      if (adxNow >= 25) {
        score += 8;
        reasons.push(`Strong ADX Trend Strength (${adxNow.toFixed(1)})`);
        strategiesAgreed.push('ADX_STRONG_TREND');
      } else if (adxNow >= 20) {
        score += 5;
        reasons.push(`Developing ADX Trend (${adxNow.toFixed(1)})`);
        strategiesAgreed.push('ADX_TREND');
      }

      // 7. Multi-EMA Ribbon / GMMA Trend Alignment (Max 8 points)
      if (ema9 !== null && ema21 !== null) {
        if (isBullish && price > ema9 && ema9 > ema21) {
          const ribbon50 = ema50 !== null && ema21 > ema50;
          score += ribbon50 ? 8 : 5;
          reasons.push(ribbon50 ? 'Full Bullish EMA Ribbon Alignment (9 > 21 > 50)' : 'Bullish EMA 9/21 Short-Term Momentum');
          strategiesAgreed.push('GMMA_EMA_RIBBON');
        } else if (!isBullish && price < ema9 && ema9 < ema21) {
          const ribbon50 = ema50 !== null && ema21 < ema50;
          score += ribbon50 ? 8 : 5;
          reasons.push(ribbon50 ? 'Full Bearish EMA Ribbon Alignment (9 < 21 < 50)' : 'Bearish EMA 9/21 Short-Term Momentum');
          strategiesAgreed.push('GMMA_EMA_RIBBON');
        }
      }

      // 8. Bollinger Band Expansion / Volatility Breakout (Max 6 points)
      if (bbUpper !== null && bbLower !== null) {
        if (isBullish && price >= bbUpper * 0.998) {
          score += 6;
          reasons.push('Bollinger Upper Band Expansion Breakout');
          strategiesAgreed.push('BB_BREAKOUT');
        } else if (!isBullish && price <= bbLower * 1.002) {
          score += 6;
          reasons.push('Bollinger Lower Band Breakdown');
          strategiesAgreed.push('BB_BREAKOUT');
        }
      }

      // 9. MACD Momentum Acceleration (Max 5 points)
      if ((isBullish && hist > 0) || (!isBullish && hist < 0)) {
        score += 5;
        reasons.push(isBullish ? 'MACD Positive Momentum Histogram' : 'MACD Negative Momentum Histogram');
        strategiesAgreed.push('MACD_CONFIRMATION');
      }

      // 10. Smart Money Concepts (SMC) & Candlestick Price Action (Max 5 points)
      const prevBar = candles.length >= 2 ? candles[candles.length - 2] : null;
      if (prevBar) {
        const isEngulfingBull = last.close > last.open && prevBar.close < prevBar.open && last.close > prevBar.open && last.open < prevBar.close;
        const isEngulfingBear = last.close < last.open && prevBar.close > prevBar.open && last.close < prevBar.open && last.open > prevBar.close;
        const isHammer = last.close > last.open && (last.open - last.low) > 1.6 * Math.abs(last.close - last.open);
        const isShootingStar = last.close < last.open && (last.high - last.open) > 1.6 * Math.abs(last.close - last.open);

        if (isBullish && (isEngulfingBull || isHammer)) {
          score += 5;
          reasons.push(isEngulfingBull ? 'Bullish Engulfing Candlestick' : 'Hammer Bullish Reversal Pin');
          strategiesAgreed.push('CANDLESTICK_PRICE_ACTION');
        } else if (!isBullish && (isEngulfingBear || isShootingStar)) {
          score += 5;
          reasons.push(isEngulfingBear ? 'Bearish Engulfing Candlestick' : 'Shooting Star Bearish Pin');
          strategiesAgreed.push('CANDLESTICK_PRICE_ACTION');
        }
      }

      // Clamp score between 0 and 100
      score = Math.min(100, Math.max(0, score));

      const side: Side = isBullish ? 'BUY' : 'SELL';
      const stopDistance = Math.round(atrVal * 1.5 * 100) / 100;
      const stopLoss = Math.round((side === 'BUY' ? price - stopDistance : price + stopDistance) * 100) / 100;
      const target1 = Math.round((side === 'BUY' ? price + stopDistance * 1.5 : price - stopDistance * 1.5) * 100) / 100;
      const target2 = Math.round((side === 'BUY' ? price + stopDistance * 2.5 : price - stopDistance * 2.5) * 100) / 100;

      // Callers may pass prior sessions as indicator warmup; "change" is since today's open.
      const firstBar = candles[sessionStartIndex(candles)];
      const openPrice = firstBar?.open ?? price;
      const changePct = openPrice > 0 ? ((price - openPrice) / openPrice) * 100 : 0;

      scored.push({
        instrumentKey: item.instrumentKey,
        symbol: item.symbol,
        name: item.name,
        ltp: price,
        changePct: Math.round(changePct * 100) / 100,
        volume: last.volume,
        orbStatus: orb,
        supertrendDir: stDir,
        rsi: Math.round(rsiNow * 10) / 10,
        vwap: Math.round(vwapNow * 100) / 100,
        rvol: Math.round(rvol * 100) / 100,
        atr: Math.round(atrVal * 100) / 100,
        adx: Math.round(adxNow * 10) / 10,
        strategiesAgreed,
        score,
        reasons,
        tradeSetup: {
          side,
          entry: price,
          stopLoss,
          target1,
          target2,
          trailingGap: Math.round(atrVal * 0.5 * 100) / 100,
          riskPerShare: stopDistance,
          rewardToRisk1: 1.5,
          rewardToRisk2: 2.5,
          recommendedShares: (budgetRupees: number) => Math.max(1, Math.floor(budgetRupees / price)),
        },
      });
    }

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    return scored.map((s, index) => ({
      ...s,
      rank: index + 1,
    }));
  }

  /**
   * Helper to convert a ScoredStock trade setup into a formal domain Signal.
   */
  toSignal(stock: ScoredStock, style: 'INTRADAY' | 'SWING' = 'INTRADAY'): Signal {
    const setup = stock.tradeSetup!;
    return {
      id: newSignalId(),
      instrumentKey: stock.instrumentKey,
      symbol: stock.symbol,
      style,
      side: setup.side,
      entry: rupeesToPaise(setup.entry),
      stopLoss: rupeesToPaise(setup.stopLoss),
      target: rupeesToPaise(setup.target1),
      atr: stock.atr,
      confidence: stock.score,
      reasons: stock.reasons,
      indicators: {
        atr: stock.atr,
        rsi: stock.rsi,
        rvol: stock.rvol,
        vwap: stock.vwap,
        ...(stock.adx ? { adx: stock.adx } : {}),
      },
      generatedAt: Date.now(),
    };
  }
}

