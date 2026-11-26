import { type Signal, type Clock, SystemClock } from '@tradeforger/core';
import { type AiDecision, applyVerdict } from './confirm.ts';
import { FreeRealtimeAnalyzer } from './free-analyzer.ts';
import { BreakoutPatternAnalyzer } from './breakout-pattern-analyzer.ts';
import { MlExpectancyAnalyzer } from './ml-expectancy-analyzer.ts';

export interface MultiModelVote {
  readonly model: string;
  readonly verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
  readonly confidence: number;
  readonly rationale: string;
  readonly flags: readonly string[];
}

export interface ConsensusDecision extends AiDecision {
  readonly votes: readonly MultiModelVote[];
  readonly consensusGrade: 'A+' | 'A' | 'B' | 'REJECT';
  readonly agreeCount: number;
  readonly totalModels: number;
}

export interface ConsensusOptions {
  readonly clock?: Clock;
}

/**
 * Multi-Model AI Consensus Engine.
 *
 * Runs 3 specialized zero-cost AI models in parallel on every trade candidate:
 *  1. free-realtime-quant-v1 (Geometry, ATR noise, and session rules)
 *  2. free-breakout-pattern-v1 (Price action, ORB breakout quality, VWAP bands)
 *  3. free-ml-expectancy-v1 (Probabilistic win-rate and EV expectancy modeling)
 *
 * Combines their votes into a high-conviction consensus decision.
 */
/**
 * Intraday volume too thin to trust a breakout: RVOL under 0.8. Strategies
 * report an RVOL they could not compute as 0 — missing data, not thin volume.
 */
export function thinVolume(signal: Pick<Signal, 'style' | 'indicators'>): boolean {
  const rvol = signal.indicators['rvol'];
  return signal.style === 'INTRADAY' && rvol !== undefined && rvol > 0 && rvol < 0.8;
}

export class AiConsensusEngine {
  private readonly quantModel: FreeRealtimeAnalyzer;
  private readonly patternModel: BreakoutPatternAnalyzer;
  private readonly mlModel: MlExpectancyAnalyzer;
  private readonly clock: Clock;

  constructor(opts: ConsensusOptions = {}) {
    this.clock = opts.clock ?? SystemClock;
    this.quantModel = new FreeRealtimeAnalyzer({ clock: this.clock });
    this.patternModel = new BreakoutPatternAnalyzer({ clock: this.clock });
    this.mlModel = new MlExpectancyAnalyzer({ clock: this.clock });
  }

  evaluate(signal: Signal, externalDecision?: AiDecision | readonly AiDecision[] | null): ConsensusDecision {
    const started = this.clock.ms();

    const d1 = this.quantModel.analyze(signal);
    const d2 = this.patternModel.analyze(signal);
    const d3 = this.mlModel.analyze(signal);

    const votes: MultiModelVote[] = [
      { model: d1.model, verdict: d1.verdict, confidence: d1.confidence, rationale: d1.rationale, flags: d1.riskFlags },
      { model: d2.model, verdict: d2.verdict, confidence: d2.confidence, rationale: d2.rationale, flags: d2.riskFlags },
      { model: d3.model, verdict: d3.verdict, confidence: d3.confidence, rationale: d3.rationale, flags: d3.riskFlags },
    ];

    const externalList = !externalDecision
      ? []
      : Array.isArray(externalDecision)
        ? externalDecision
        : [externalDecision];

    for (const ext of externalList) {
      if (ext && !ext.fellBack) {
        votes.push({
          model: ext.model,
          verdict: ext.verdict,
          confidence: ext.confidence,
          rationale: ext.rationale,
          flags: ext.riskFlags,
        });
      }
    }

    const rejects = votes.filter((v) => v.verdict === 'REJECT');
    const cautions = votes.filter((v) => v.verdict === 'CAUTION');
    const confirms = votes.filter((v) => v.verdict === 'CONFIRM');
    const allFlags = Array.from(new Set(votes.flatMap((v) => [...v.flags])));

    const rsi = signal.indicators['rsi'];
    const isLong = signal.side === 'BUY';
    const hardExtreme = (rsi !== undefined && rsi > 0 && (isLong ? rsi > 75 : rsi < 25))
      || thinVolume(signal);
    const DISQUALIFIER_FLAGS = new Set([
      'RSI_OVERBOUGHT', 'RSI_OVERSOLD', 'THIN_VOLUME', 'OVERSTRETCHED_FROM_VWAP',
      'INSIDE_RANGE_ENTRY', 'TIGHT_STOP_NOISE_RISK',
    ]);
    const hasDisqualifier = hardExtreme
      || allFlags.some((f) => DISQUALIFIER_FLAGS.has(f) || /OVERBOUGHT|OVERSOLD|THIN_VOL|STRETCH|CHASE|EXHAUST/i.test(f));

    let verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
    let grade: 'A+' | 'A' | 'B' | 'REJECT';
    let cautionBlocked = false;

    // Strict safety asymmetry: if ANY model finds a fatal flaw, or consensus CAUTION coincides with
    // exhaustion/thin-volume/multi-model caution against chasing, block execution rather than halving size.
    if (rejects.length > 0) {
      verdict = 'REJECT';
      grade = 'REJECT';
    } else if (cautions.length >= 2 || confirms.length === 0) {
      if (hasDisqualifier || cautions.length >= 2) {
        verdict = 'REJECT';
        grade = 'REJECT';
        cautionBlocked = true;
      } else {
        verdict = 'CAUTION';
        grade = 'B';
      }
    } else if (confirms.length === votes.length) {
      verdict = 'CONFIRM';
      grade = 'A+';
    } else {
      verdict = 'CONFIRM';
      grade = 'A';
    }

    const { sizeMultiplier, blocked } = applyVerdict({
      verdict,
      confidence: 0,
      risk_flags: [],
      rationale: '',
    });

    const avgConfidence = Math.round(
      votes.reduce((sum, v) => sum + v.confidence, 0) / votes.length,
    );

    const rationale = cautionBlocked
      ? `Consensus BLOCKED (${cautions.length} caution(s), disqualifiers: ${allFlags.join(', ') || 'momentum/volume chase'}). ${votes.map((v) => `[${v.model}: ${v.verdict}]`).join(' ')}`
      : `Consensus ${verdict} [Grade ${grade}] with ${confirms.length}/${votes.length} models confirming. ${votes.map((v) => `[${v.model}: ${v.verdict}]`).join(' ')}`;

    // Beginner-friendly aggregation prioritizing external LLM insights if available
    const primaryExt = externalList.find((e) => !e.fellBack && (e.beginnerSummary || e.trafficLights)) ?? externalList[0];

    const beginnerSummary = primaryExt?.beginnerSummary ?? (
      verdict === 'REJECT'
        ? `Consensus REJECT: ${rejects.length} AI model(s) flagged this trade as unsafe. Key risk: ${allFlags.join(', ') || 'Inadequate risk profile'}. Preserve your capital and do not enter.`
        : verdict === 'CAUTION'
          ? `Consensus CAUTION: ${confirms.length} of ${votes.length} models confirm this setup, but caution flags (${allFlags.join(', ') || 'moderate risk'}) were detected. Half size (0.5x) recommended.`
          : `Consensus CONFIRM (Grade ${grade}): High-conviction setup verified across ${confirms.length}/${votes.length} quantitative and AI models. Trend, volume, and risk geometry are in full alignment.`
    );

    const beginnerTip = primaryExt?.beginnerTip ?? (
      verdict === 'REJECT'
        ? 'Rule #1 of trading: The best trades are effortless; never force a trade that fails risk checks.'
        : 'Never risk more than 1% to 2% of total trading capital on any single setup, and keep stop-loss placed in the market.'
    );

    const riskRating: 'LOW' | 'MEDIUM' | 'HIGH' = primaryExt?.riskRating ?? (verdict === 'REJECT' ? 'HIGH' : verdict === 'CAUTION' ? 'MEDIUM' : 'LOW');

    const trafficLights = primaryExt?.trafficLights ?? {
      momentum: d2.trafficLights?.momentum ?? (verdict === 'CONFIRM' ? 'GREEN' : 'AMBER'),
      volume: d1.trafficLights?.volume ?? (verdict === 'CONFIRM' ? 'GREEN' : 'AMBER'),
      riskBuffer: d1.trafficLights?.riskBuffer ?? (verdict === 'REJECT' ? 'RED' : 'GREEN'),
      rewardRatio: d3.trafficLights?.rewardRatio ?? (verdict === 'CONFIRM' ? 'GREEN' : 'AMBER'),
    };

    const actionChecklist = primaryExt?.actionChecklist ?? [
      { item: 'Multi-Model Consensus Alignment', passed: confirms.length >= 2, detail: `${confirms.length} of ${votes.length} models confirming` },
      { item: 'Risk/Reward & Stop Protection', passed: !allFlags.includes('INVERTED_STOP') && !allFlags.includes('POOR_RISK_REWARD'), detail: 'Stop placed below support' },
      { item: 'Volume & Institutional Flow', passed: !allFlags.includes('THIN_VOLUME'), detail: 'Volume verified' },
      { item: 'Mathematical Edge (+EV)', passed: !allFlags.includes('NEGATIVE_EXPECTANCY'), detail: `Expectancy Grade ${grade}` },
    ];

    return {
      verdict,
      confidence: avgConfidence,
      riskFlags: allFlags,
      rationale,
      sizeMultiplier,
      blocked,
      latencyMs: Math.max(1, this.clock.ms() - started),
      model: 'ai-consensus-ensemble-v1',
      fellBack: false,
      votes,
      consensusGrade: grade,
      agreeCount: confirms.length,
      totalModels: votes.length,
      beginnerSummary,
      beginnerTip,
      riskRating,
      trafficLights,
      actionChecklist,
    };
  }
}

