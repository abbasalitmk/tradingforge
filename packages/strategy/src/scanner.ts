import {
  type Candle, type Signal, type Side,
  newSignalId, rupeesToPaise, paiseToRupees,
} from '@tradeforger/core';
import {
  closes, latest, ema, atr, supertrend, rsi,
  vwap, relativeVolume, openingRange, orbState,
} from '@tradeforger/indicators';

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
 * Scans candidate stocks across the active universe, measures volume expansion,
 * opening range breakout momentum, SuperTrend & VWAP alignment, and ranks stocks
 * from best to worst to identify the single highest-probability setup of the day.
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

      let score = 0;
      const reasons: string[] = [];

      // 1. Breakout Quality (Max 35 points)
      if (orb === 'ABOVE') {
        score += 35;
        reasons.push('Decisive 15m ORB Breakout Above');
      } else if (orb === 'BELOW') {
        score += 35;
        reasons.push('Decisive 15m ORB Breakdown Below');
      } else {
        score += 5;
      }

      // 2. Volume Expansion (Max 25 points)
      if (rvol >= 2.2) {
        score += 25;
        reasons.push(`High Institutional Volume (${rvol.toFixed(1)}x RVOL)`);
      } else if (rvol >= 1.5) {
        score += 18;
        reasons.push(`Above Average Volume (${rvol.toFixed(1)}x RVOL)`);
      } else if (rvol >= 1.0) {
        score += 10;
      }

      // 3. Trend Alignment (Max 20 points)
      const isBullish = orb === 'ABOVE' || (orb === 'INSIDE' && stDir === 'BULLISH');
      if (isBullish && stDir === 'BULLISH') {
        score += 20;
        reasons.push('SuperTrend Bullish Confirmation');
      } else if (!isBullish && stDir === 'BEARISH') {
        score += 20;
        reasons.push('SuperTrend Bearish Confirmation');
      }

      // 4. VWAP Location (Max 12 points)
      if (isBullish && price > vwapNow) {
        score += 12;
        reasons.push('Trading above intraday VWAP benchmark');
      } else if (!isBullish && price < vwapNow) {
        score += 12;
        reasons.push('Trading below intraday VWAP benchmark');
      }

      // 5. RSI Sweet Spot (Max 8 points)
      if (isBullish && rsiNow >= 55 && rsiNow <= 70) {
        score += 8;
        reasons.push(`RSI ${rsiNow.toFixed(1)} in prime acceleration zone`);
      } else if (!isBullish && rsiNow <= 45 && rsiNow >= 30) {
        score += 8;
        reasons.push(`RSI ${rsiNow.toFixed(1)} in prime breakdown zone`);
      }

      const side: Side = isBullish ? 'BUY' : 'SELL';
      const stopDistance = Math.round(atrVal * 1.5 * 100) / 100;
      const stopLoss = Math.round((side === 'BUY' ? price - stopDistance : price + stopDistance) * 100) / 100;
      const target1 = Math.round((side === 'BUY' ? price + stopDistance * 1.5 : price - stopDistance * 1.5) * 100) / 100;
      const target2 = Math.round((side === 'BUY' ? price + stopDistance * 2.5 : price - stopDistance * 2.5) * 100) / 100;

      const firstBar = candles[0];
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
      },
      generatedAt: Date.now(),
    };
  }
}

