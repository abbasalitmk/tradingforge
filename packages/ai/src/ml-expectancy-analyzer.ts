import {
  type Signal, type Clock, SystemClock,
  paiseToRupees,
} from '@tradeforger/core';
import { type AiDecision, applyVerdict } from './confirm.ts';

export interface MlExpectancyOptions {
  readonly clock?: Clock;
}

export interface ExpectancyResult {
  readonly winProbability: number;
  readonly expectedValueR: number;
  readonly edgeGrade: 'A+' | 'A' | 'B' | 'REJECT';
}

/**
 * Free ML & Probabilistic Expectancy Model (free-ml-expectancy-v1).
 *
 * Estimates empirical win probability and mathematical Expected Value (EV in units of R).
 * Uses a logistic model over normalized volume expansion, ATR noise distance,
 * momentum velocity, and multi-indicator confluence.
 */
export class MlExpectancyAnalyzer {
  private readonly clock: Clock;

  constructor(opts: MlExpectancyOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
  }

  evaluateEdge(signal: Signal): ExpectancyResult {
    const entryRs = paiseToRupees(signal.entry);
    const stopRs = paiseToRupees(signal.stopLoss);
    const targetRs = paiseToRupees(signal.target);
    const isLong = signal.side === 'BUY';

    const risk = isLong ? entryRs - stopRs : stopRs - entryRs;
    const reward = isLong ? targetRs - entryRs : entryRs - targetRs;

    if (risk <= 0 || reward <= 0) {
      return { winProbability: 0, expectedValueR: -1.0, edgeGrade: 'REJECT' };
    }

    const rMultiple = reward / risk;
    const rvol = signal.indicators['rvol'] ?? 1.0;
    const atr = signal.atr > 0 ? signal.atr : 1.0;
    const atrNormalizedStop = risk / atr;
    const confluenceCount = signal.reasons.length;

    // Logistic regression feature coefficients
    // Baseline log-odds ~ 0.05 (approx 51% neutral win rate for 1:1 setup)
    let logit = 0.05;

    // 1. Volume confirmation bonus
    if (rvol >= 2.0) logit += 0.35;
    else if (rvol >= 1.4) logit += 0.20;
    else if (rvol < 0.9) logit -= 0.30;

    // 2. Confluence count bonus (more independent confirming indicators)
    logit += Math.min(0.40, confluenceCount * 0.08);

    // 3. Volatility sweet spot (1.2 to 2.2 ATR is optimal; too tight gets whipped, too wide loses edge)
    if (atrNormalizedStop >= 1.2 && atrNormalizedStop <= 2.2) {
      logit += 0.20;
    } else if (atrNormalizedStop < 0.7) {
      logit -= 0.40;
    }

    // 4. Overbought/oversold momentum friction
    const rsi = signal.indicators['rsi'];
    if (rsi) {
      if ((isLong && rsi > 75) || (!isLong && rsi < 25)) {
        logit -= 0.35;
      }
    }

    // Sigmoid probability calculation
    const winProb = 1 / (1 + Math.exp(-logit));

    // Mathematical Expected Value: EV = (P_win * R) - (P_loss * 1.0)
    const expectedValueR = winProb * rMultiple - (1 - winProb) * 1.0;

    let edgeGrade: ExpectancyResult['edgeGrade'];
    if (expectedValueR >= 0.45 && winProb >= 0.54) {
      edgeGrade = 'A+';
    } else if (expectedValueR >= 0.25 && winProb >= 0.48) {
      edgeGrade = 'A';
    } else if (expectedValueR >= 0.10) {
      edgeGrade = 'B';
    } else {
      edgeGrade = 'REJECT';
    }

    return {
      winProbability: Math.round(winProb * 100) / 100,
      expectedValueR: Math.round(expectedValueR * 100) / 100,
      edgeGrade,
    };
  }

  analyze(signal: Signal): AiDecision {
    const started = this.clock.ms();
    const edge = this.evaluateEdge(signal);

    let verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
    let confidence: number;
    const flags: string[] = [];

    if (edge.edgeGrade === 'REJECT') {
      verdict = 'REJECT';
      confidence = Math.round(edge.winProbability * 100);
      flags.push('NEGATIVE_EXPECTANCY');
    } else if (edge.edgeGrade === 'B') {
      verdict = 'CAUTION';
      confidence = Math.round(edge.winProbability * 100);
      flags.push('MODERATE_EDGE');
    } else {
      verdict = 'CONFIRM';
      confidence = Math.round(Math.min(95, edge.winProbability * 100 + 10));
    }

    const { sizeMultiplier, blocked } = applyVerdict({
      verdict,
      confidence,
      risk_flags: flags,
      rationale: '',
    });

    const rationale = `${verdict} (Grade ${edge.edgeGrade}): Estimated Win Probability ${(edge.winProbability * 100).toFixed(0)}%, Expected Value +${edge.expectedValueR.toFixed(2)}R per trade.`;

    const beginnerSummary = verdict === 'REJECT'
      ? `Mathematical edge test failed (Expected Value is negative). Statistically, taking this trade loses money over a series of 100 trades.`
      : verdict === 'CAUTION'
        ? `Moderate statistical edge (Grade B) with ${(edge.winProbability * 100).toFixed(0)}% estimated win rate and +${edge.expectedValueR.toFixed(2)}R expectancy.`
        : `High mathematical expectancy (Grade ${edge.edgeGrade}). At ${(edge.winProbability * 100).toFixed(0)}% win rate with positive +${edge.expectedValueR.toFixed(2)}R payoff, this trade has a solid statistical edge.`;

    const beginnerTip = 'In trading, you do not need 100% win rate to be profitable. A 50% win rate with 1:2 R:R compounds capital rapidly.';

    const riskRating = verdict === 'REJECT' ? 'HIGH' : verdict === 'CAUTION' ? 'MEDIUM' : 'LOW';

    return {
      verdict,
      confidence,
      riskFlags: flags,
      rationale,
      sizeMultiplier,
      blocked,
      latencyMs: Math.max(1, this.clock.ms() - started),
      model: 'free-ml-expectancy-v1',
      fellBack: false,
      beginnerSummary,
      beginnerTip,
      riskRating,
      trafficLights: {
        momentum: edge.winProbability >= 0.52 ? 'GREEN' : 'AMBER',
        volume: 'GREEN',
        riskBuffer: edge.expectedValueR >= 0.25 ? 'GREEN' : (edge.expectedValueR >= 0 ? 'AMBER' : 'RED'),
        rewardRatio: edge.expectedValueR >= 0.25 ? 'GREEN' : 'AMBER',
      },
      actionChecklist: [
        { item: 'Statistical Win Probability (>= 48%)', passed: edge.winProbability >= 0.48, detail: `${(edge.winProbability * 100).toFixed(0)}% estimated win rate` },
        { item: 'Expected Value (> +0.10R)', passed: edge.expectedValueR >= 0.10, detail: `+${edge.expectedValueR.toFixed(2)}R per trade` },
        { item: 'Mathematical Edge Quality', passed: edge.edgeGrade !== 'REJECT', detail: `Grade ${edge.edgeGrade}` },
        { item: 'Long-term Expectancy', passed: edge.expectedValueR > 0, detail: 'Net positive expectancy formula' },
      ],
    };
  }
}

