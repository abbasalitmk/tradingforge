import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise, type OrderRequest, type PositionId } from '@tradeforger/core';
import { PaperBroker, DEFAULT_PAPER_CONFIG } from './paper.ts';

const P = (r: number) => Math.round(r * 100) as Paise;
const clock = () => new FixedClock(new Date('2026-09-14T04:30:00Z'));
const KEY = 'NSE_EQ|INE002A01018';

/** latencyMs 0 keeps tests fast; every other default is unchanged. */
const broker = (over = {}) =>
  new PaperBroker(clock(), { ...DEFAULT_PAPER_CONFIG, latencyMs: 0, ...over });

function order(over: Partial<OrderRequest> = {}): OrderRequest {
  return {
    positionId: 'pos_test' as PositionId,
    instrumentKey: KEY,
    side: 'BUY',
    quantity: 10,
    orderType: 'MARKET',
    product: 'I',
    validity: 'DAY',
    price: P(1000),
    triggerPrice: P(0),
    tag: 'tf_test',
    ...over,
  };
}

const tick = (ltp: number) => ({ instrumentKey: KEY, ltp, ts: Date.now() });

describe('refuses to invent a price', () => {
  it('blocks an order when no tick has been seen for the instrument', async () => {
    const b = broker();
    const r = await b.placeOrder(order());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('BLOCKED');
      expect(r.error.message).toContain('refusing to invent');
    }
  });

  it('accepts once a tick has arrived', async () => {
    const b = broker();
    b.onTick(tick(1000));
    expect((await b.placeOrder(order())).ok).toBe(true);
  });
});

describe('slippage always moves against the trader', () => {
  it('a BUY fills above the last traded price', async () => {
    const b = broker({ partialFillProbability: 0 });
    b.onTick(tick(1000));
    await b.placeOrder(order({ side: 'BUY' }));
    const fills = await b.openOrders();
    expect(fills.ok).toBe(true);
    if (fills.ok) expect(fills.value[0]!.averagePrice).toBeGreaterThan(P(1000));
  });

  it('a SELL fills below the last traded price', async () => {
    const b = broker({ partialFillProbability: 0 });
    b.onTick(tick(1000));
    await b.placeOrder(order({ side: 'SELL' }));
    const fills = await b.openOrders();
    if (fills.ok) expect(fills.value[0]!.averagePrice).toBeLessThan(P(1000));
  });

  it('applies the configured basis points', async () => {
    const b = broker({ partialFillProbability: 0, slippageBps: 10 });
    b.onTick(tick(1000));
    await b.placeOrder(order({ side: 'BUY' }));
    const fills = await b.openOrders();
    if (fills.ok) expect(fills.value[0]!.averagePrice).toBe(P(1001)); // +0.1%
  });
});

describe('limit orders', () => {
  it('does not fill while the market is away from the limit', async () => {
    const b = broker();
    b.onTick(tick(1010));
    await b.placeOrder(order({ orderType: 'LIMIT', side: 'BUY', price: P(1000) }));
    const fills = await b.openOrders();
    if (fills.ok) expect(fills.value[0]!.status).toBe('PENDING');
  });

  it('fills at the limit price when the market crosses it', async () => {
    const b = broker();
    b.onTick(tick(995));
    await b.placeOrder(order({ orderType: 'LIMIT', side: 'BUY', price: P(1000) }));
    const fills = await b.openOrders();
    if (fills.ok) {
      expect(fills.value[0]!.status).toBe('FILLED');
      // No slippage on a limit fill — you get your price or nothing.
      expect(fills.value[0]!.averagePrice).toBe(P(1000));
    }
  });
});

describe('GTT bracket mirrors Upstox MULTIPLE semantics', () => {
  const longBracket = {
    instrumentKey: KEY, quantity: 10, product: 'I' as const,
    exitSide: 'SELL' as const, targetPrice: P(1050), stopLossPrice: P(980),
  };

  it('stays active while price sits between the legs', async () => {
    const b = broker();
    b.onTick(tick(1000));
    await b.placeBracket(longBracket);
    b.onTick(tick(1020));
    expect(b.inspect().activeBrackets).toBe(1);
  });

  it('closes the whole bracket when the target triggers', async () => {
    const b = broker();
    b.onTick(tick(1000));
    await b.placeBracket(longBracket);
    b.onTick(tick(1051));
    // One GTT order, so the sibling leg dies with it — no orphan to cancel.
    expect(b.inspect().activeBrackets).toBe(0);
  });

  it('closes the whole bracket when the stop triggers', async () => {
    const b = broker();
    b.onTick(tick(1000));
    await b.placeBracket(longBracket);
    b.onTick(tick(979));
    expect(b.inspect().activeBrackets).toBe(0);
  });

  it('prefers the stop when an inverted bracket matches both legs', async () => {
    const b = broker({ slippageBps: 0 });
    b.onTick(tick(1000));
    // Inverted: target BELOW stop. A well-formed long bracket cannot do this,
    // so this only fires on a malformed spec — and must not book a phantom win.
    await b.placeBracket({ ...longBracket, targetPrice: P(995), stopLossPrice: P(1005) });
    b.onTick(tick(1000)); // <= 1005 (stop) and ... not <= 995, so only stop matches

    const fills = await b.openOrders();
    if (fills.ok) {
      const exit = fills.value.find((f) => f.side === 'SELL');
      expect(exit?.averagePrice).toBe(P(1005));
    }
  });

  it('a single tick cannot trigger both legs of a well-formed bracket', async () => {
    const b = broker({ slippageBps: 0 });
    b.onTick(tick(1000));
    await b.placeBracket({ ...longBracket, targetPrice: P(1001), stopLossPrice: P(999) });
    b.onTick(tick(1001));

    const fills = await b.openOrders();
    if (fills.ok) {
      const exit = fills.value.find((f) => f.side === 'SELL');
      // Price reached the target and never touched the stop — filling at the
      // stop here would understate the strategy, which is its own kind of lie.
      expect(exit?.averagePrice).toBe(P(1001));
    }
  });

  it('handles a short bracket with inverted legs', async () => {
    const b = broker();
    b.onTick(tick(1000));
    await b.placeBracket({
      instrumentKey: KEY, quantity: 10, product: 'I',
      exitSide: 'BUY', targetPrice: P(950), stopLossPrice: P(1020),
    });
    b.onTick(tick(949));
    expect(b.inspect().activeBrackets).toBe(0);
  });
});

describe('determinism', () => {
  it('the same seed produces the same fills — replay is reproducible', async () => {
    const run = async () => {
      const b = broker({ seed: 7 });
      b.onTick(tick(1000));
      for (let i = 0; i < 5; i++) await b.placeOrder(order());
      const f = await b.openOrders();
      return f.ok ? f.value.map((x) => `${x.filledQuantity}@${x.averagePrice}`) : [];
    };
    expect(await run()).toEqual(await run());
  });

  it('a different seed produces different partial-fill behaviour', async () => {
    const run = async (seed: number) => {
      const b = broker({ seed, partialFillProbability: 0.5 });
      b.onTick(tick(1000));
      for (let i = 0; i < 10; i++) await b.placeOrder(order());
      const f = await b.openOrders();
      return f.ok ? f.value.map((x) => x.filledQuantity).join(',') : '';
    };
    expect(await run(1)).not.toBe(await run(999));
  });
});

describe('lifecycle', () => {
  it('rejects quantity below one', async () => {
    const b = broker();
    b.onTick(tick(1000));
    const r = await b.placeOrder(order({ quantity: 0 }));
    expect(r.ok).toBe(false);
  });

  it('cannot cancel a filled order', async () => {
    const b = broker({ partialFillProbability: 0 });
    b.onTick(tick(1000));
    const ack = await b.placeOrder(order());
    if (ack.ok) {
      const c = await b.cancelOrder(ack.value.brokerOrderId);
      expect(c.ok).toBe(false);
    }
  });

  it('exitAllPositions deactivates every live bracket', async () => {
    const b = broker();
    b.onTick(tick(1000));
    await b.placeBracket({ instrumentKey: KEY, quantity: 5, product: 'I', exitSide: 'SELL', targetPrice: P(1100), stopLossPrice: P(900) });
    const r = await b.exitAllPositions();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(1);
    expect(b.inspect().activeBrackets).toBe(0);
  });

  it('reports PAPER mode and is never live', () => {
    const b = broker();
    expect(b.mode).toBe('PAPER');
    expect(b.isLive).toBe(false);
  });
});
