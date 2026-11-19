import type { Signal, Clock } from '@tradeforger/core';
import { SystemClock } from '@tradeforger/core';
import { Confirmer, type AiDecision, type ConfirmerConfig } from './confirm.ts';
import { FreeRealtimeAnalyzer } from './free-analyzer.ts';
import { BreakoutPatternAnalyzer } from './breakout-pattern-analyzer.ts';
import { MlExpectancyAnalyzer } from './ml-expectancy-analyzer.ts';
import { AiConsensusEngine, type ConsensusDecision } from './consensus.ts';

export interface AiReviewerOptions {
  readonly clock?: Clock;
  readonly grokConfig?: ConfirmerConfig | null;
  readonly groqConfig?: ConfirmerConfig | null;
}

/**
 * Enterprise Autonomous AI Review Engine.
 *
 * Coordinates 3 built-in free quantitative models:
 *  1. FreeRealtimeAnalyzer (Risk/geometry & session timing)
 *  2. BreakoutPatternAnalyzer (Candlestick & breakout structure)
 *  3. MlExpectancyAnalyzer (Statistical win-rate and EV expectancy)
 * Plus optional xAI Grok and Groq Cloud models with automatic consensus voting.
 */
export class AiReviewer {
  readonly quantModel: FreeRealtimeAnalyzer;
  readonly patternModel: BreakoutPatternAnalyzer;
  readonly mlModel: MlExpectancyAnalyzer;
  readonly consensusEngine: AiConsensusEngine;
  private readonly confirmer: Confirmer | null;

  constructor(opts: AiReviewerOptions = {}) {
    const clock = opts.clock ?? SystemClock;
    this.quantModel = new FreeRealtimeAnalyzer({ clock });
    this.patternModel = new BreakoutPatternAnalyzer({ clock });
    this.mlModel = new MlExpectancyAnalyzer({ clock });
    this.consensusEngine = new AiConsensusEngine({ clock });

    if (opts.grokConfig && opts.groqConfig) {
      // Primary: xAI Grok, Failover: Groq Qwen
      this.confirmer = new Confirmer(opts.grokConfig, opts.groqConfig);
    } else if (opts.grokConfig) {
      this.confirmer = new Confirmer(opts.grokConfig);
    } else if (opts.groqConfig) {
      this.confirmer = new Confirmer(opts.groqConfig);
    } else {
      this.confirmer = null;
    }
  }

  async review(signal: Signal): Promise<ConsensusDecision> {
    let remoteDecision: AiDecision | null = null;

    if (this.confirmer) {
      try {
        const d = await this.confirmer.review(signal);
        if (!d.fellBack) {
          remoteDecision = d;
        }
      } catch {
        // Fall back gracefully
      }
    }

    return this.consensusEngine.evaluate(signal, remoteDecision);
  }
}
