import type { Signal, Clock } from '@tradeforger/core';
import { SystemClock } from '@tradeforger/core';
import { Confirmer, type AiDecision, type ConfirmerConfig } from './confirm.ts';
import { FreeRealtimeAnalyzer } from './free-analyzer.ts';
import { BreakoutPatternAnalyzer } from './breakout-pattern-analyzer.ts';
import { MlExpectancyAnalyzer } from './ml-expectancy-analyzer.ts';
import { AiConsensusEngine, type ConsensusDecision } from './consensus.ts';

export interface AiReviewerOptions {
  readonly clock?: Clock;
  readonly geminiConfig?: ConfirmerConfig | null;
  readonly grokConfig?: ConfirmerConfig | null;
  readonly groqConfig?: ConfirmerConfig | null;
}

/**
 * Enterprise Autonomous AI Review Engine.
 *
 * Coordinates 3 built-in quantitative models:
 *  1. FreeRealtimeAnalyzer (Risk/geometry & session timing)
 *  2. BreakoutPatternAnalyzer (Candlestick & breakout structure)
 *  3. MlExpectancyAnalyzer (Statistical win-rate and EV expectancy)
 * Plus external AI LLM models (Google Gemini, xAI Grok, Groq Cloud)
 * executing in parallel with consensus voting.
 */
export class AiReviewer {
  readonly quantModel: FreeRealtimeAnalyzer;
  readonly patternModel: BreakoutPatternAnalyzer;
  readonly mlModel: MlExpectancyAnalyzer;
  readonly consensusEngine: AiConsensusEngine;
  private readonly geminiConfirmer: Confirmer | null;
  private readonly grokConfirmer: Confirmer | null;
  private readonly groqConfirmer: Confirmer | null;

  constructor(opts: AiReviewerOptions = {}) {
    const clock = opts.clock ?? SystemClock;
    this.quantModel = new FreeRealtimeAnalyzer({ clock });
    this.patternModel = new BreakoutPatternAnalyzer({ clock });
    this.mlModel = new MlExpectancyAnalyzer({ clock });
    this.consensusEngine = new AiConsensusEngine({ clock });

    this.geminiConfirmer = opts.geminiConfig ? new Confirmer(opts.geminiConfig) : null;
    this.grokConfirmer = opts.grokConfig ? new Confirmer(opts.grokConfig) : null;
    this.groqConfirmer = opts.groqConfig ? new Confirmer(opts.groqConfig) : null;
  }

  async review(signal: Signal): Promise<ConsensusDecision> {
    const remotePromises: Promise<AiDecision>[] = [];
    if (this.geminiConfirmer) remotePromises.push(this.geminiConfirmer.review(signal));
    if (this.grokConfirmer) remotePromises.push(this.grokConfirmer.review(signal));
    if (this.groqConfirmer) remotePromises.push(this.groqConfirmer.review(signal));

    const settled = await Promise.allSettled(remotePromises);
    const remoteDecisions: AiDecision[] = [];

    for (const r of settled) {
      if (r.status === 'fulfilled' && !r.value.fellBack) {
        remoteDecisions.push(r.value);
      }
    }

    return this.consensusEngine.evaluate(signal, remoteDecisions);
  }
}
