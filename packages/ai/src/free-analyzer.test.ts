import { describe, it, expect } from 'vitest';
import { FixedClock, type Signal, newSignalId, rupeesToPaise } from '@tradeforger/core';
import { FreeRealtimeAnalyzer } from './free-analyzer.ts';
import { AiReviewer } from './reviewer.ts';

const clock = new FixedClock(new Date('2026-09-14T05:30:00Z')); // 11:00 IST

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: newSignalId(),
    instrumentKey: 'NSE_EQ|INFY',
    symbol: 'INFY',
    style: 'INTRADAY',
    side: 'BUY',
    entry: rupeesToPaise(1500),
    stopLoss: rupeesToPaise(1485), // risk 15
    target: rupeesToPaise(1530),   // reward 30 -> 2:1 R:R
    atr: 10,                       // 1.5x ATR stop
    confidence: 80,
    reasons: ['ORB ABOVE', 'Supertrend UP'],
    indicators: {
      atr: 10,
      rsi: 58,
      rvol: 1.8,
    },
    generatedAt: clock.ms(),
    ...overrides,
  };
}

describe('FreeRealtimeAnalyzer', () => {
  const analyzer = new FreeRealtimeAnalyzer({ clock });

  it('CONFIRMS a sound trade setup with excellent geometry and volume', () => {
    const signal = makeSignal();
    const decision = analyzer.analyze(signal);

    expect(decision.verdict).toBe('CONFIRM');
    expect(decision.blocked).toBe(false);
    expect(decision.sizeMultiplier).toBe(1.0);
    expect(decision.riskFlags).toEqual([]);
    expect(decision.rationale).toContain('CONFIRM');
  });

  it('REJECTS inverted stop-loss setup', () => {
    // BUY with stop ABOVE entry
    const signal = makeSignal({
      entry: rupeesToPaise(1500),
      stopLoss: rupeesToPaise(1520),
    });
    const decision = analyzer.analyze(signal);

    expect(decision.verdict).toBe('REJECT');
    expect(decision.blocked).toBe(true);
    expect(decision.sizeMultiplier).toBe(0);
    expect(decision.riskFlags).toContain('INVERTED_STOP');
  });

  it('REJECTS poor risk:reward ratio below 1.0', () => {
    const signal = makeSignal({
      entry: rupeesToPaise(1500),
      stopLoss: rupeesToPaise(1480), // risk 20
      target: rupeesToPaise(1510),   // reward 10 -> 0.5:1
    });
    const decision = analyzer.analyze(signal);

    expect(decision.verdict).toBe('REJECT');
    expect(decision.blocked).toBe(true);
    expect(decision.riskFlags).toContain('POOR_RISK_REWARD');
  });

  it('CAUTIONS when momentum is overbought and volume is thin', () => {
    const signal = makeSignal({
      indicators: {
        atr: 10,
        rsi: 78,  // overbought
        rvol: 0.7, // thin volume
      },
    });
    const decision = analyzer.analyze(signal);

    expect(decision.verdict).toBe('CAUTION');
    expect(decision.blocked).toBe(false);
    expect(decision.sizeMultiplier).toBe(0.5);
    expect(decision.riskFlags).toContain('RSI_OVERBOUGHT');
    expect(decision.riskFlags).toContain('THIN_VOLUME');
  });

  it('works seamlessly through AiReviewer with zero config', async () => {
    const reviewer = new AiReviewer({ clock });
    const decision = await reviewer.review(makeSignal());
    expect(decision.verdict).toBe('CONFIRM');
    expect(decision.model).toBe('ai-consensus-ensemble-v1');
    expect(decision.votes.some((v) => v.model === 'free-realtime-quant-v1')).toBe(true);
  });
});

