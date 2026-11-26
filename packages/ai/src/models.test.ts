import { describe, it, expect } from 'vitest';
import { FixedClock, type Signal, newSignalId, rupeesToPaise } from '@tradeforger/core';
import { BreakoutPatternAnalyzer } from './breakout-pattern-analyzer.ts';
import { MlExpectancyAnalyzer } from './ml-expectancy-analyzer.ts';
import { AiConsensusEngine, thinVolume } from './consensus.ts';
import { AiReviewer } from './reviewer.ts';

const clock = new FixedClock(new Date('2026-09-14T05:30:00Z')); // 11:00 IST

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: newSignalId(),
    instrumentKey: 'NSE_EQ|RELIANCE',
    symbol: 'RELIANCE',
    style: 'INTRADAY',
    side: 'BUY',
    entry: rupeesToPaise(1340),
    stopLoss: rupeesToPaise(1325), // risk 15
    target: rupeesToPaise(1370),   // reward 30 -> 2:1 R:R
    atr: 10,
    confidence: 85,
    reasons: ['ORB ABOVE', 'Supertrend UP', 'EMA9 > EMA21', 'RVOL 2.4x'],
    indicators: {
      atr: 10,
      rsi: 60,
      rvol: 2.4,
      orbHigh: 1335,
      orbLow: 1315,
      vwap: 1330,
      supertrend: 1320,
      ema9: 1338,
      ema21: 1332,
    },
    generatedAt: clock.ms(),
    ...overrides,
  };
}

describe('BreakoutPatternAnalyzer (free-breakout-pattern-v1)', () => {
  const model = new BreakoutPatternAnalyzer({ clock });

  it('CONFIRMS decisive breakout above ORB high with VWAP support', () => {
    const signal = makeSignal();
    const decision = model.analyze(signal);

    expect(decision.verdict).toBe('CONFIRM');
    expect(decision.blocked).toBe(false);
    expect(decision.model).toBe('free-breakout-pattern-v1');
    expect(decision.rationale).toContain('CONFIRM');
  });

  it('REJECTS long trade when trading against SuperTrend', () => {
    // Supertrend above price for a BUY signal
    const signal = makeSignal({
      indicators: {
        atr: 10,
        supertrend: 1360, // Above entry -> Supertrend is BEARISH
        vwap: 1330,
        orbHigh: 1335,
        orbLow: 1315,
      },
    });
    const decision = model.analyze(signal);

    expect(decision.verdict).toBe('REJECT');
    expect(decision.blocked).toBe(true);
    expect(decision.riskFlags).toContain('AGAINST_SUPERTREND');
  });
});

describe('MlExpectancyAnalyzer (free-ml-expectancy-v1)', () => {
  const model = new MlExpectancyAnalyzer({ clock });

  it('calculates positive expected value (+EV) and Grade A+ for strong breakout', () => {
    const signal = makeSignal();
    const edge = model.evaluateEdge(signal);

    expect(edge.winProbability).toBeGreaterThan(0.5);
    expect(edge.expectedValueR).toBeGreaterThan(0.3);
    expect(['A+', 'A']).toContain(edge.edgeGrade);

    const decision = model.analyze(signal);
    expect(decision.verdict).toBe('CONFIRM');
    expect(decision.model).toBe('free-ml-expectancy-v1');
  });

  it('REJECTS setups with inverted risk geometry', () => {
    const signal = makeSignal({
      entry: rupeesToPaise(1340),
      stopLoss: rupeesToPaise(1350), // Inverted!
    });
    const edge = model.evaluateEdge(signal);

    expect(edge.edgeGrade).toBe('REJECT');
    expect(edge.expectedValueR).toBeLessThan(0);
  });
});

describe('AiConsensusEngine & Multi-Model Reviewer', () => {
  it('achieves Grade A+ consensus across all free models on ideal trade', () => {
    const engine = new AiConsensusEngine({ clock });
    const consensus = engine.evaluate(makeSignal());

    expect(consensus.verdict).toBe('CONFIRM');
    expect(consensus.consensusGrade).toBe('A+');
    expect(consensus.votes.length).toBe(3);
    expect(consensus.agreeCount).toBe(3);
  });

  it('AiReviewer returns comprehensive consensus decision', async () => {
    const reviewer = new AiReviewer({ clock });
    const decision = await reviewer.review(makeSignal());

    expect(decision.verdict).toBe('CONFIRM');
    expect(decision.votes.length).toBe(3);
    expect(decision.votes.map((v) => v.model)).toContain('free-realtime-quant-v1');
    expect(decision.votes.map((v) => v.model)).toContain('free-breakout-pattern-v1');
    expect(decision.votes.map((v) => v.model)).toContain('free-ml-expectancy-v1');
  });

  it('aggregates multiple remote AI models (Gemini + Grok) into consensus votes', () => {
    const engine = new AiConsensusEngine({ clock });
    const geminiDecision = {
      verdict: 'CONFIRM' as const,
      confidence: 90,
      riskFlags: [],
      rationale: 'Gemini confirmed clean breakout',
      sizeMultiplier: 1,
      blocked: false,
      latencyMs: 850,
      model: 'gemini-3.5-flash-lite',
      fellBack: false,
      beginnerSummary: 'High probability momentum entry',
    };
    const grokDecision = {
      verdict: 'CONFIRM' as const,
      confidence: 88,
      riskFlags: [],
      rationale: 'Grok confirmed order book alignment',
      sizeMultiplier: 1,
      blocked: false,
      latencyMs: 720,
      model: 'grok-2-latest',
      fellBack: false,
      beginnerSummary: 'Volume surge verified',
    };

    const consensus = engine.evaluate(makeSignal(), [geminiDecision, grokDecision]);
    expect(consensus.votes.length).toBe(5); // 3 quant + Gemini + Grok
    expect(consensus.votes.map((v) => v.model)).toContain('gemini-3.5-flash-lite');
    expect(consensus.votes.map((v) => v.model)).toContain('grok-2-latest');
    expect(consensus.agreeCount).toBe(5);
    expect(consensus.consensusGrade).toBe('A+');
    expect(consensus.beginnerSummary).toBe('High probability momentum entry');
  });

  it('blocks consensus when multiple models caution on RSI overbought or thin RVOL instead of trading half size', () => {
    const engine = new AiConsensusEngine({ clock });
    const overbought = makeSignal({
      indicators: { atr: 10, rsi: 85.07, rvol: 0.75, orbHigh: 1335, orbLow: 1315, vwap: 1330, supertrend: 1320, ema9: 1338, ema21: 1332 },
    });
    const consensus = engine.evaluate(overbought);
    expect(consensus.verdict).toBe('REJECT');
    expect(consensus.blocked).toBe(true);
    expect(consensus.sizeMultiplier).toBe(0);
    expect(consensus.consensusGrade).toBe('REJECT');
  });

  it('does not read an unknown RVOL (reported as 0) as thin volume', () => {
    const at = (rvol: number) => thinVolume({ style: 'INTRADAY', indicators: { rvol } });
    expect(at(0.75)).toBe(true);
    expect(at(0)).toBe(false);
    expect(at(1.5)).toBe(false);
    expect(thinVolume({ style: 'SWING', indicators: { rvol: 0.5 } })).toBe(false);
  });

  it('blocks when remote LLMs also caution against overbought chasing even on modest local edge', () => {
    const engine = new AiConsensusEngine({ clock });
    const stretched = makeSignal({
      indicators: { atr: 10, rsi: 76, rvol: 1.1, orbHigh: 1335, orbLow: 1315, vwap: 1330, supertrend: 1320, ema9: 1338, ema21: 1332 },
    });
    const extCaution = {
      verdict: 'CAUTION' as const, confidence: 60, riskFlags: ['RSI_OVERBOUGHT'], rationale: 'Overbought chase',
      sizeMultiplier: 0.5, blocked: false, latencyMs: 200, model: 'gemini-3.5-flash-lite', fellBack: false,
    };
    const consensus = engine.evaluate(stretched, [extCaution]);
    expect(consensus.verdict).toBe('REJECT');
    expect(consensus.blocked).toBe(true);
  });
});

