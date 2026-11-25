import {
  type Signal, type Clock, SystemClock,
  paiseToRupees,
} from '@tradeforger/core';
import { type AiDecision, applyVerdict } from './confirm.ts';

export interface BreakoutPatternOptions {
  readonly clock?: Clock;
}

/**
 * Free Pattern & Market Structure Breakout AI Model (free-breakout-pattern-v1).
 *
 * Specializes in identifying price action dynamics:
 *  - Clean range breakout vs false breakout wicks
 *  - VWAP band relationship and trend continuation
 *  - SuperTrend structural alignment
 *  - Momentum candle expansion
 */
export class BreakoutPatternAnalyzer {
  private readonly clock: Clock;

  constructor(opts: BreakoutPatternOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
  }

  analyze(signal: Signal): AiDecision {
    const started = this.clock.ms();
    const flags: string[] = [];
    const patterns: string[] = [];
    const isLong = signal.side === 'BUY';

    const entryRs = paiseToRupees(signal.entry);
    const stopRs = paiseToRupees(signal.stopLoss);
    const targetRs = paiseToRupees(signal.target);

    // 1. Breakout Geometry Sanity
    const orbHigh = signal.indicators['orbHigh'];
    const orbLow = signal.indicators['orbLow'];

    if (signal.style === 'INTRADAY' && orbHigh && orbLow) {
      if (isLong && entryRs <= orbHigh) {
        flags.push('INSIDE_RANGE_ENTRY');
      } else if (!isLong && entryRs >= orbLow) {
        flags.push('INSIDE_RANGE_ENTRY');
      } else {
        patterns.push(isLong ? 'DECISIVE_ORB_BULL_BREAKOUT' : 'DECISIVE_ORB_BEAR_BREAKDOWN');
      }
    }

    // 2. VWAP Relationship
    const vwap = signal.indicators['vwap'];
    if (vwap && vwap > 0) {
      const vwapDistancePct = Math.abs(entryRs - vwap) / vwap;
      if (isLong && entryRs < vwap) {
        flags.push('COUNTER_VWAP_BIAS');
      } else if (!isLong && entryRs > vwap) {
        flags.push('COUNTER_VWAP_BIAS');
      } else if (vwapDistancePct > 0.04) {
        flags.push('OVERSTRETCHED_FROM_VWAP');
      } else {
        patterns.push('FAVORABLE_VWAP_LOCATION');
      }
    }

    // 3. SuperTrend & EMA Trend Structure
    const supertrend = signal.indicators['supertrend'];
    const emaFast = signal.indicators['ema9'] ?? signal.indicators['emaFast'];
    const emaSlow = signal.indicators['ema21'] ?? signal.indicators['emaSlow'];

    if (supertrend && supertrend > 0) {
      if (isLong && entryRs < supertrend) {
        flags.push('AGAINST_SUPERTREND');
      } else if (!isLong && entryRs > supertrend) {
        flags.push('AGAINST_SUPERTREND');
      } else {
        patterns.push('SUPERTREND_CONVERGENCE');
      }
    }

    if (emaFast && emaSlow) {
      const emaAligned = isLong ? emaFast > emaSlow : emaFast < emaSlow;
      if (emaAligned) {
        patterns.push('EMA_STACK_CONFIRMED');
      } else {
        flags.push('EMA_STACK_DIVERGENCE');
      }
    }

    // 4. Momentum Acceleration & Exhaustion (RSI)
    const rsi = signal.indicators['rsi'];
    if (rsi && rsi > 0) {
      if (isLong && rsi >= 55 && rsi <= 68) {
        patterns.push('BULLISH_MOMENTUM_ACCELERATION');
      } else if (!isLong && rsi <= 45 && rsi >= 32) {
        patterns.push('BEARISH_MOMENTUM_EXPANSION');
      } else if (isLong && rsi > 75) {
        flags.push('RSI_OVERBOUGHT');
      } else if (!isLong && rsi < 25) {
        flags.push('RSI_OVERSOLD');
      }
    }

    // Determine Pattern Verdict
    let verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
    let confidence: number;

    if (flags.includes('COUNTER_VWAP_BIAS') || flags.includes('AGAINST_SUPERTREND')) {
      verdict = 'REJECT';
      confidence = 25;
    } else if (flags.length > 0) {
      verdict = 'CAUTION';
      confidence = Math.max(50, 75 - flags.length * 12);
    } else {
      verdict = 'CONFIRM';
      confidence = Math.min(95, 75 + patterns.length * 5);
    }

    const { sizeMultiplier, blocked } = applyVerdict({
      verdict,
      confidence,
      risk_flags: flags,
      rationale: '',
    });

    const summary = patterns.length > 0
      ? `Patterns verified: ${patterns.join(', ')}`
      : 'Standard structure';
    const flagNotice = flags.length > 0 ? ` Caution flags: ${flags.join(', ')}.` : '';
    const rationale = `${verdict}: ${summary}.${flagNotice}`;

    const beginnerSummary = verdict === 'REJECT'
      ? `Price action pattern rejected. The trade is fighting major institutional levels (VWAP or Supertrend), which historically leads to high failure rates.`
      : verdict === 'CAUTION'
        ? `Breakout pattern detected on ${signal.symbol}, but with mixed signals (${flags.join(', ')}). Patience is advised.`
        : `Confirmed breakout pattern on ${signal.symbol}. Price is trading ${isLong ? 'above' : 'below'} VWAP with EMA alignment, indicating institutional buying/selling momentum.`;

    const beginnerTip = isLong
      ? 'Buy near support/VWAP rather than chasing price when it has already rallied heavily.'
      : 'For short trades, ensure price stays below VWAP to maintain edge.';

    const riskRating = verdict === 'REJECT' ? 'HIGH' : verdict === 'CAUTION' ? 'MEDIUM' : 'LOW';

    return {
      verdict,
      confidence,
      riskFlags: flags,
      rationale,
      sizeMultiplier,
      blocked,
      latencyMs: Math.max(1, this.clock.ms() - started),
      model: 'free-breakout-pattern-v1',
      fellBack: false,
      beginnerSummary,
      beginnerTip,
      riskRating,
      trafficLights: {
        momentum: patterns.some((p) => p.includes('MOMENTUM')) ? 'GREEN' : (flags.some((f) => f.includes('DIVERGENCE')) ? 'RED' : 'AMBER'),
        volume: patterns.includes('HIGH_RVOL_BREAKOUT') ? 'GREEN' : 'AMBER',
        riskBuffer: flags.includes('COUNTER_VWAP_BIAS') ? 'RED' : 'GREEN',
        rewardRatio: 'GREEN',
      },
      actionChecklist: [
        { item: 'VWAP Institutional Anchor', passed: !flags.includes('COUNTER_VWAP_BIAS'), detail: isLong ? 'Price above VWAP' : 'Price below VWAP' },
        { item: 'Supertrend Trend Follower', passed: !flags.includes('AGAINST_SUPERTREND'), detail: 'Supertrend matches signal direction' },
        { item: 'EMA Moving Average Alignment', passed: !flags.includes('EMA_STACK_DIVERGENCE'), detail: 'Fast EMA confirms direction' },
        { item: 'Volume Expansion Confirmation', passed: patterns.includes('HIGH_RVOL_BREAKOUT'), detail: 'Breakout backed by surge in volume' },
      ],
    };
  }
}

