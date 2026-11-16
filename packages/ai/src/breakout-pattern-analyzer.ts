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

    // 4. Momentum Acceleration (RSI)
    const rsi = signal.indicators['rsi'];
    if (rsi && rsi > 0) {
      if (isLong && rsi >= 55 && rsi <= 68) {
        patterns.push('BULLISH_MOMENTUM_ACCELERATION');
      } else if (!isLong && rsi <= 45 && rsi >= 32) {
        patterns.push('BEARISH_MOMENTUM_EXPANSION');
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
    };
  }
}

