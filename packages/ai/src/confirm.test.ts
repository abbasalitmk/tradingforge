import { describe, it, expect } from 'vitest';
import type { Signal, SignalId, Paise } from '@tradeforger/core';
import { applyVerdict, fallbackDecision, verdictSchema, buildPayload, Confirmer } from './confirm.ts';

const P = (r: number) => Math.round(r * 100) as Paise;
const signal: Signal = {
  id: 'sig_1' as SignalId,
  instrumentKey: 'NSE_EQ|INE002A01018',
  symbol: 'RELIANCE',
  style: 'INTRADAY',
  side: 'BUY',
  entry: P(1000), stopLoss: P(985), target: P(1030),
  atr: 10, confidence: 78,
  reasons: ['ORB ABOVE', 'RVOL 2.4x'],
  indicators: { atr: 10, adx: 28, rsi: 62 },
  generatedAt: Date.now(),
};

describe('the AI can only ever reduce risk', () => {
  it('CONFIRM changes nothing — it cannot size up', () => {
    const r = applyVerdict({ verdict: 'CONFIRM', confidence: 99, risk_flags: [], rationale: '' });
    expect(r.sizeMultiplier).toBe(1);
    expect(r.blocked).toBe(false);
  });

  it('a 100-confidence CONFIRM still cannot exceed multiplier 1', () => {
    const r = applyVerdict({ verdict: 'CONFIRM', confidence: 100, risk_flags: [], rationale: '' });
    expect(r.sizeMultiplier).toBeLessThanOrEqual(1);
  });

  it('CAUTION halves size', () => {
    expect(applyVerdict({ verdict: 'CAUTION', confidence: 40, risk_flags: [], rationale: '' }).sizeMultiplier).toBe(0.5);
  });

  it('REJECT blocks the trade entirely', () => {
    const r = applyVerdict({ verdict: 'REJECT', confidence: 10, risk_flags: ['bad stop'], rationale: '' });
    expect(r.blocked).toBe(true);
    expect(r.sizeMultiplier).toBe(0);
  });
});

describe('failure falls through to the deterministic signal', () => {
  it('proceeds at full size when the model is unreachable', () => {
    const d = fallbackDecision('timeout', 800, 'openai/gpt-oss-120b');
    expect(d.blocked).toBe(false);
    expect(d.sizeMultiplier).toBe(1);
    expect(d.fellBack).toBe(true);
    expect(d.confidence).toBe(0);
  });
});

describe('response schema is strict', () => {
  it('accepts a well-formed verdict', () => {
    expect(verdictSchema.safeParse({
      verdict: 'CAUTION', confidence: 55, risk_flags: ['late in session'], rationale: 'ok',
    }).success).toBe(true);
  });

  it.each([
    ['unknown verdict', { verdict: 'MAYBE', confidence: 50, risk_flags: [], rationale: '' }],
    ['confidence out of range', { verdict: 'CONFIRM', confidence: 150, risk_flags: [], rationale: '' }],
    ['missing field', { verdict: 'CONFIRM', confidence: 50 }],
    ['wrong type', { verdict: 'CONFIRM', confidence: 'high', risk_flags: [], rationale: '' }],
  ])('rejects %s', (_label, bad) => {
    expect(verdictSchema.safeParse(bad).success).toBe(false);
  });
});

describe('payload is structured, never prose', () => {
  it('sends numbers in rupees with a computed risk:reward', () => {
    const p = JSON.parse(buildPayload(signal));
    expect(p.entry).toBe(1000);
    expect(p.stop_loss).toBe(985);
    expect(p.risk_reward).toBe(2); // 30 / 15
    expect(p.symbol).toBe('RELIANCE');
  });
});

describe('timeout behaviour', () => {
  it('falls back rather than blocking the order path', async () => {
    const c = new Confirmer({
      apiKey: 'unused',
      // Unroutable address so the request cannot complete.
      baseUrl: 'http://127.0.0.1:9',
      model: 'test',
      timeoutMs: 150,
    });
    const started = Date.now();
    const d = await c.review(signal);
    expect(d.fellBack).toBe(true);
    expect(d.blocked).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('provider failover', () => {
  const dead = { apiKey: 'x', baseUrl: 'http://127.0.0.1:9', model: 'dead', timeoutMs: 100 };

  it('falls back to the second provider when the first is unreachable', async () => {
    // Both dead here — the point is that it TRIES the second and reports so.
    const c = new Confirmer(dead, { ...dead, model: 'dead-2' });
    const d = await c.review(signal);
    expect(d.fellBack).toBe(true);
    expect(d.rationale).toContain('both providers unavailable');
    // Still never blocks: an AI outage costs a review, not a trade.
    expect(d.blocked).toBe(false);
    expect(d.sizeMultiplier).toBe(1);
  });

  it('does not consult the fallback when the primary answered', async () => {
    // A REJECT is a real answer. Retrying it on another provider would let the
    // system shop for a permissive verdict, defeating the safety layer.
    const c = new Confirmer(dead, null);
    const d = await c.review(signal);
    expect(d.fellBack).toBe(true);
    expect(d.rationale).not.toContain('both providers');
  });
});
