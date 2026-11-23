import {
  type Signal, type Clock, SystemClock,
  istMinutes, paiseToRupees,
} from '@tradeforger/core';
import {
  type Verdict, type AiDecision, applyVerdict,
} from './confirm.ts';

export interface FreeAnalyzerOptions {
  readonly clock?: Clock;
}

/**
 * Free Real-Time Technical & Quantitative AI Analysis Engine.
 *
 * Runs locally with sub-millisecond latency and ZERO external API costs.
 * Applies multi-factor risk validation:
 *  1. Geometry integrity (stop-loss orientation, minimum risk:reward)
 *  2. Volatility noise tolerance (ATR distance check)
 *  3. Momentum exhaustion guard (RSI extremes)
 *  4. Volume participation verification (RVOL)
 *  5. Session timing safety (Opening volatility / Late day decay)
 */
export class FreeRealtimeAnalyzer {
  private readonly clock: Clock;

  constructor(opts: FreeAnalyzerOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
  }

  analyze(signal: Signal): AiDecision {
    const started = this.clock.ms();
    const flags: string[] = [];
    const notes: string[] = [];

    const entryRs = paiseToRupees(signal.entry);
    const stopRs = paiseToRupees(signal.stopLoss);
    const targetRs = paiseToRupees(signal.target);
    const isLong = signal.side === 'BUY';

    // ── 1. Geometry & Risk-Reward checks ────────────────────────────────
    const risk = isLong ? entryRs - stopRs : stopRs - entryRs;
    const reward = isLong ? targetRs - entryRs : entryRs - targetRs;

    if (risk <= 0) {
      const rationale = `REJECT: Inverted stop-loss (${stopRs.toFixed(2)} on ${signal.side} at ${entryRs.toFixed(2)}).`;
      return {
        verdict: 'REJECT',
        confidence: 0,
        riskFlags: ['INVERTED_STOP'],
        rationale,
        sizeMultiplier: 0,
        blocked: true,
        latencyMs: Math.max(1, this.clock.ms() - started),
        model: 'free-realtime-quant-v1',
        fellBack: false,
      };
    }

    if (reward <= 0) {
      const rationale = `REJECT: Target price is inverted relative to entry.`;
      return {
        verdict: 'REJECT',
        confidence: 0,
        riskFlags: ['INVERTED_TARGET'],
        rationale,
        sizeMultiplier: 0,
        blocked: true,
        latencyMs: Math.max(1, this.clock.ms() - started),
        model: 'free-realtime-quant-v1',
        fellBack: false,
      };
    }

    const rr = reward / risk;
    if (rr < 1.0) {
      const rationale = `REJECT: Inadequate risk:reward (${rr.toFixed(2)}:1 is below the minimum 1.0:1 threshold).`;
      return {
        verdict: 'REJECT',
        confidence: 10,
        riskFlags: ['POOR_RISK_REWARD'],
        rationale,
        sizeMultiplier: 0,
        blocked: true,
        latencyMs: Math.max(1, this.clock.ms() - started),
        model: 'free-realtime-quant-v1',
        fellBack: false,
      };
    }

    if (rr < 1.5) {
      flags.push('SUB_OPTIMAL_RR');
      notes.push(`R:R is ${rr.toFixed(2)}:1 (acceptable but modest)`);
    } else {
      notes.push(`Favorable R:R ${rr.toFixed(2)}:1`);
    }

    // ── 2. Volatility & Stop Distance check ──────────────────────────────
    const atr = signal.atr;
    if (atr > 0) {
      const atrMultiple = risk / atr;
      if (atrMultiple < 0.6) {
        flags.push('TIGHT_STOP_NOISE_RISK');
        notes.push(`Stop is only ${(atrMultiple).toFixed(2)}x ATR; vulnerable to market noise`);
      } else if (signal.style === 'INTRADAY' && atrMultiple > 3.0) {
        flags.push('WIDE_INTRADAY_STOP');
        notes.push(`Stop is ${(atrMultiple).toFixed(2)}x ATR; requires large move to hit target`);
      } else {
        notes.push(`Stop geometry well-proportioned at ${(atrMultiple).toFixed(2)}x ATR`);
      }
    }

    // ── 3. Momentum Exhaustion check ─────────────────────────────────────
    const rsi = signal.indicators['rsi'];
    if (rsi !== undefined && rsi > 0) {
      if (isLong && rsi > 72) {
        flags.push('RSI_OVERBOUGHT');
        notes.push(`RSI at ${rsi.toFixed(1)} indicates momentum may be overextended`);
      } else if (!isLong && rsi < 28) {
        flags.push('RSI_OVERSOLD');
        notes.push(`RSI at ${rsi.toFixed(1)} indicates oversold selling climax`);
      }
    }

    // ── 4. Volume Participation check ────────────────────────────────────
    const rvol = signal.indicators['rvol'];
    if (rvol !== undefined && rvol > 0) {
      if (rvol < 0.9) {
        flags.push('THIN_VOLUME');
        notes.push(`Relative volume is low (${rvol.toFixed(2)}x)`);
      } else if (rvol >= 1.5) {
        notes.push(`Strong institutional volume (${rvol.toFixed(2)}x)`);
      }
    }

    // ── 5. Session Timing check (for Intraday) ───────────────────────────
    if (signal.style === 'INTRADAY') {
      const mins = istMinutes(this.clock.now());
      if (mins < 9 * 60 + 20) {
        flags.push('OPENING_AUCTION_NOISE');
        notes.push('Trade candidate generated during high-volatility opening 5 minutes');
      } else if (mins >= 14 * 60 + 30) {
        flags.push('LATE_SESSION_ENTRY');
        notes.push('Late intraday entry allows insufficient time for trade to mature before 15:05 IST square-off');
      }
    }

    // ── Verdict determination ────────────────────────────────────────────
    let verdict: Verdict['verdict'];
    let confidence: number;

    if (flags.includes('LATE_SESSION_ENTRY')) {
      verdict = 'REJECT';
      confidence = 15;
    } else if (flags.length > 0) {
      verdict = 'CAUTION';
      confidence = Math.max(45, Math.min(75, signal.confidence - flags.length * 10));
    } else {
      verdict = 'CONFIRM';
      confidence = Math.max(75, Math.min(95, signal.confidence + 5));
    }

    const { sizeMultiplier, blocked } = applyVerdict({
      verdict,
      confidence,
      risk_flags: flags,
      rationale: '',
    });

    const rationale = `${verdict}: ${notes.join('. ')}.`;

    const momentumLight = (!rsi || (isLong && rsi >= 45 && rsi <= 70) || (!isLong && rsi <= 55 && rsi >= 30))
      ? 'GREEN'
      : (flags.includes('RSI_OVERBOUGHT') || flags.includes('RSI_OVERSOLD') ? 'RED' : 'AMBER');

    const volumeLight = (!rvol || rvol >= 1.2) ? 'GREEN' : (rvol >= 0.9 ? 'AMBER' : 'RED');
    const riskLight = (!atr || (atr > 0 && risk >= 0.8 * atr)) ? 'GREEN' : 'RED';
    const rewardLight = rr >= 2.0 ? 'GREEN' : (rr >= 1.5 ? 'AMBER' : 'RED');

    const beginnerSummary = verdict === 'REJECT'
      ? `This setup was rejected because the risk profile is too dangerous (e.g. inverted stop or unfavorable risk/reward). Capital safety comes first.`
      : verdict === 'CAUTION'
        ? `This ${signal.side} setup on ${signal.symbol} is valid but carries elevated risk (${flags.join(', ')}). Consider trading with half size (0.5x).`
        : `Strong ${signal.side} setup on ${signal.symbol}. Clean risk-to-reward ratio of ${rr.toFixed(1)}:1 with entry at ₹${entryRs.toFixed(2)}, stop-loss at ₹${stopRs.toFixed(2)} (risk ₹${risk.toFixed(2)}), and target at ₹${targetRs.toFixed(2)}.`;

    const beginnerTip = verdict === 'REJECT'
      ? 'Do not take this trade. Wait for a clearer pattern with structural support.'
      : `Never move your stop-loss further away once entered. Cut losses quickly if ₹${stopRs.toFixed(2)} is breached.`;

    const riskRating = verdict === 'REJECT' ? 'HIGH' : verdict === 'CAUTION' ? 'MEDIUM' : 'LOW';

    return {
      verdict,
      confidence,
      riskFlags: flags,
      rationale,
      sizeMultiplier,
      blocked,
      latencyMs: Math.max(1, this.clock.ms() - started),
      model: 'free-realtime-quant-v1',
      fellBack: false,
      beginnerSummary,
      beginnerTip,
      riskRating,
      trafficLights: {
        momentum: momentumLight,
        volume: volumeLight,
        riskBuffer: riskLight,
        rewardRatio: rewardLight,
      },
      actionChecklist: [
        { item: 'Risk/Reward Ratio (>= 1.5:1)', passed: rr >= 1.5, detail: `Current R:R is ${rr.toFixed(2)}:1` },
        { item: 'ATR Stop Buffer (> 0.8 ATR)', passed: !atr || risk >= 0.8 * atr, detail: `Stop distance: ₹${risk.toFixed(2)}` },
        { item: 'Momentum Health (RSI)', passed: !flags.includes('RSI_OVERBOUGHT') && !flags.includes('RSI_OVERSOLD'), detail: `RSI is ${rsi?.toFixed(1) ?? 'N/A'}` },
        { item: 'Trading Session Window', passed: !flags.includes('LATE_SESSION_ENTRY'), detail: 'Execution within allowed hours' },
      ],
    };
  }
}

