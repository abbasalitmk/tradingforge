import { describe, it, expect } from 'vitest';
import type { Paise } from '@tradeforger/core';
import { DEFAULT_LIMITS } from '@tradeforger/safety';
import { size, type SizingInput } from './sizing.ts';

const P = (rupees: number) => Math.round(rupees * 100) as Paise;

function input(over: Partial<SizingInput> = {}): SizingInput {
  return {
    mode: 'FIXED_BUDGET',
    entry: P(1000),
    stopLoss: P(980),
    capital: P(100_000),
    availableMargin: P(100_000),
    lotSize: 1,
    avgDailyVolume: 1_000_000,
    deployedCapital: P(0),
    budget: P(10_000),
    ...over,
  };
}

describe('FIXED_BUDGET — "buy only what fits this price limit"', () => {
  it('buys floor(budget / price)', () => {
    const r = size(input({ budget: P(10_000), entry: P(1000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(10);
      expect(r.result.costPaise).toBe(P(10_000));
    }
  });

  it('never overspends the budget on an awkward price', () => {
    const r = size(input({ budget: P(10_000), entry: P(1257.5) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(7); // 7 x 1257.5 = 8802.50, 8 would be 10060
      expect(r.result.costPaise).toBeLessThanOrEqual(P(10_000));
    }
  });
});

describe('FIXED_QTY — and why the rupee ceiling matters', () => {
  it('honours the requested quantity when it fits every cap', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 5, entry: P(1000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(5);
      expect(r.result.boundBy).toBe('mode');
    }
  });

  it('clamps a fixed quantity that would breach the per-trade spend ceiling', () => {
    // 25 shares of a ₹3,000 stock = ₹75,000, far past the ₹10,000 ceiling.
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 25, entry: P(3000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(3); // floor(10000 / 3000)
      expect(r.result.boundBy).toBe('maxSpendPerTrade');
    }
  });

  it('the same fixed quantity is fine on a cheap stock — which is the hazard', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 25, entry: P(100) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.quantity).toBe(25); // ₹2,500, within ceiling
  });
});

describe('RISK_BASED', () => {
  it('sizes so a stop-out loses exactly the risked percentage', () => {
    // 1% of ₹1,00,000 = ₹1,000 risk; ₹20 per share → 50 shares.
    // But 50 x ₹1,000 = ₹50,000 exceeds the ₹10,000 per-trade ceiling → 10.
    const r = size(input({ mode: 'RISK_BASED', riskPct: 1, entry: P(1000), stopLoss: P(980) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.caps.mode).toBe(50);
      expect(r.result.quantity).toBe(10);
      expect(r.result.boundBy).toBe('maxSpendPerTrade');
    }
  });

  it('a wider stop produces a smaller position for the same risk', () => {
    const tight = size(input({ mode: 'RISK_BASED', riskPct: 1, entry: P(100), stopLoss: P(99) }), DEFAULT_LIMITS);
    const wide = size(input({ mode: 'RISK_BASED', riskPct: 1, entry: P(100), stopLoss: P(90) }), DEFAULT_LIMITS);
    expect(tight.ok && wide.ok).toBe(true);
    if (tight.ok && wide.ok) {
      expect(tight.result.caps.mode).toBeGreaterThan(wide.result.caps.mode);
    }
  });
});

describe('hard caps apply in every mode', () => {
  it('liquidity cap limits to 1% of average daily volume', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 1000, entry: P(100), avgDailyVolume: 5_000 }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(50);
      expect(r.result.boundBy).toBe('liquidity');
    }
  });

  it('refuses once the deployed-capital ceiling leaves no room', () => {
    const r = size(input({ deployedCapital: P(49_900), entry: P(1000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('DEPLOYED_CAP_REACHED');
  });

  it('limits to what remains under the deployed ceiling', () => {
    const r = size(input({ deployedCapital: P(45_000), entry: P(1000), budget: P(10_000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.quantity).toBe(5); // ₹5,000 left of the ₹50,000 ceiling
      expect(r.result.boundBy).toBe('deployedCapital');
    }
  });

  it('refuses when margin cannot cover the cost', () => {
    const r = size(input({ availableMargin: P(500), entry: P(1000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
  });
});

describe('rejections that protect the edge', () => {
  it('refuses a zero-width stop rather than dividing by zero', () => {
    const r = size(input({ mode: 'RISK_BASED', riskPct: 1, entry: P(1000), stopLoss: P(1000) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('INVALID_STOP');
  });

  it('refuses a ticket too small for charges to be worth paying', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 1, entry: P(500) }), DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BELOW_MIN_TICKET');
  });

  it('requires the input its mode depends on', () => {
    for (const mode of ['FIXED_QTY', 'FIXED_BUDGET', 'RISK_BASED'] as const) {
      const r = size({ ...input({ mode }), fixedQty: undefined, budget: undefined, riskPct: undefined }, DEFAULT_LIMITS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('MISSING_MODE_INPUT');
    }
  });
});

describe('lot size', () => {
  it('rounds down to whole lots', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 17, entry: P(500), lotSize: 5 }), DEFAULT_LIMITS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.quantity).toBe(15);
  });

  it('rejects when less than one lot fits', () => {
    const r = size(input({ mode: 'FIXED_BUDGET', budget: P(1000), entry: P(500), lotSize: 100 }), DEFAULT_LIMITS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('QTY_BELOW_ONE');
  });
});

describe('boundBy explains the decision', () => {
  it('names the constraint that actually determined the size', () => {
    const r = size(input({ mode: 'FIXED_QTY', fixedQty: 10_000, entry: P(1000), avgDailyVolume: 100 }), DEFAULT_LIMITS);
    if (r.ok) {
      // liquidity gives 1, spend ceiling gives 10 → liquidity binds, then
      // quantity 1 costs ₹1,000 which is below the minimum ticket.
      expect(r.result.boundBy).toBe('liquidity');
    } else {
      expect(r.reason).toBe('BELOW_MIN_TICKET');
    }
  });
});
