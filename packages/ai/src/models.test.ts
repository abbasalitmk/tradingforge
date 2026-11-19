import { describe, it, expect } from 'vitest';
import { FixedClock, type Signal, newSignalId, rupeesToPaise } from '@tradeforger/core';
import { BreakoutPatternAnalyzer } from './breakout-pattern-analyzer.ts';
import { MlExpectancyAnalyzer } from './ml-expectancy-analyzer.ts';
import { AiConsensusEngine } from './consensus.ts';
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
});

