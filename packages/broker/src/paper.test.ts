import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise, type OrderRequest, type PositionId } from '@tradeforger/core';
import { PaperBroker, DEFAULT_PAPER_CONFIG } from './paper.ts';
import type { BracketOrder, BrokerEvent } from './port.ts';

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

describe('GTT MULTIPLE bracket: entry + OCO exits in one order', () => {
  const POS = 'pos_test' as PositionId;
  const longBracket: BracketOrder = {
    positionId: POS, instrumentKey: KEY, side: 'BUY', quantity: 10, product: 'I',
    entryTrigger: 'IMMEDIATE', entryPrice: P(1000),
    targetPrice: P(1050), stopLossPrice: P(980),
  };
  const withEvents = (over = {}) => {
    const b = broker(over);
    const events: BrokerEvent[] = [];
    b.onEvent((e) => events.push(e));
    return { b, events };
  };

  it('fills an IMMEDIATE entry at the market with slippage against us', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    await b.placeBracketOrder(longBracket);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'ENTRY_FILLED', positionId: POS, quantity: 10 });
    expect((events[0] as { avgPrice: number }).avgPrice).toBeGreaterThan(P(1000));
  });

  it('refuses a bracket with no market data rather than inventing a price', async () => {
    const r = await broker().placeBracketOrder(longBracket);
    expect(r.ok).toBe(false);
  });

  it('rejects legs on the wrong side of the entry', async () => {
    const b = broker();
    b.onTick(tick(1000));
    const r = await b.placeBracketOrder({ ...longBracket, targetPrice: P(995), stopLossPrice: P(1005) });
    expect(r.ok).toBe(false);
  });

  it('stays open while price sits between the legs', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    await b.placeBracketOrder(longBracket);
    b.onTick(tick(1020));
    expect(b.inspect().activeBrackets).toBe(1);
    expect(events.filter((e) => e.kind === 'EXIT_FILLED')).toHaveLength(0);
  });

  it('closes the whole bracket at the target price, never better', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    await b.placeBracketOrder(longBracket);
    b.onTick(tick(1070));
    expect(b.inspect().activeBrackets).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'TARGET', avgPrice: P(1050) });
  });

  it('fills the stop at the gapped price, not the stop level', async () => {
    const { b, events } = withEvents({ slippageBps: 0 });
    b.onTick(tick(1000));
    await b.placeBracketOrder(longBracket);
    b.onTick(tick(960)); // gapped 20 through the 980 stop
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'STOPLOSS', avgPrice: P(960) });
  });

  it('a single tick cannot trigger both legs of a well-formed bracket', async () => {
    const { b, events } = withEvents({ slippageBps: 0 });
    b.onTick(tick(1000));
    await b.placeBracketOrder({ ...longBracket, targetPrice: P(1001), stopLossPrice: P(999) });
    b.onTick(tick(1001));
    const exits = events.filter((e) => e.kind === 'EXIT_FILLED');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ leg: 'TARGET', avgPrice: P(1001) });
  });

  it('handles a short bracket', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    await b.placeBracketOrder({
      ...longBracket, side: 'SELL', targetPrice: P(950), stopLossPrice: P(1020),
    });
    b.onTick(tick(949));
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'TARGET' });
  });

  it('waits for an ABOVE entry trigger before filling', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    await b.placeBracketOrder({ ...longBracket, entryTrigger: 'ABOVE', entryPrice: P(1010), targetPrice: P(1060), stopLossPrice: P(990) });
    expect(events).toHaveLength(0);
    b.onTick(tick(1005));
    expect(events).toHaveLength(0);
    b.onTick(tick(1011));
    expect(events[0]).toMatchObject({ kind: 'ENTRY_FILLED' });
  });

  it('trails the stop up behind price and never loosens it', async () => {
    const { b, events } = withEvents({ slippageBps: 0 });
    b.onTick(tick(1000));
    await b.placeBracketOrder({ ...longBracket, targetPrice: P(1200), trailingGap: P(10) });
    b.onTick(tick(1040)); // stop trails to 1030
    b.onTick(tick(1035)); // above 1030 — stop must not move down
    expect(events.filter((e) => e.kind === 'EXIT_FILLED')).toHaveLength(0);
    b.onTick(tick(1029));
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'STOPLOSS', avgPrice: P(1029) });
  });

  it('cannot cancel a bracket whose leg already fired — the caller must not exit twice', async () => {
    const b = broker();
    b.onTick(tick(1000));
    const ack = await b.placeBracketOrder(longBracket);
    b.onTick(tick(1060));
    expect(ack.ok && (await b.cancelBracket(ack.value.gttOrderId)).ok).toBe(false);
  });

  it('cancelling a pending entry reports that nothing was entered', async () => {
    const { b, events } = withEvents();
    b.onTick(tick(1000));
    const ack = await b.placeBracketOrder({ ...longBracket, entryTrigger: 'ABOVE', entryPrice: P(1010), targetPrice: P(1060), stopLossPrice: P(990) });
    if (ack.ok) await b.cancelBracket(ack.value.gttOrderId);
    expect(events).toEqual([expect.objectContaining({ kind: 'ENTRY_FAILED', positionId: POS })]);
  });

  it('exitPosition fills at market and reports a MANUAL exit', async () => {
    const { b, events } = withEvents({ slippageBps: 0 });
    b.onTick(tick(1000));
    await b.placeBracketOrder(longBracket);
    b.onTick(tick(1010));
    await b.exitPosition({ positionId: POS, instrumentKey: KEY, side: 'SELL', quantity: 10, product: 'I' });
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'MANUAL', avgPrice: P(1010) });
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

  it('exitAllPositions flattens every open bracket and reports the exits', async () => {
    const b = broker();
    const events: BrokerEvent[] = [];
    b.onEvent((e) => events.push(e));
    b.onTick(tick(1000));
    await b.placeBracketOrder({
      positionId: 'pos_a' as PositionId, instrumentKey: KEY, side: 'BUY', quantity: 5, product: 'I',
      entryTrigger: 'IMMEDIATE', entryPrice: P(1000), targetPrice: P(1100), stopLossPrice: P(900),
    });
    const r = await b.exitAllPositions();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(1);
    expect(b.inspect().activeBrackets).toBe(0);
    expect(events.at(-1)).toMatchObject({ kind: 'EXIT_FILLED', leg: 'MANUAL', positionId: 'pos_a' });
  });

  it('reports PAPER mode and is never live', () => {
    const b = broker();
    expect(b.mode).toBe('PAPER');
    expect(b.isLive).toBe(false);
  });
});
