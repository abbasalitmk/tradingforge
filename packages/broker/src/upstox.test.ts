import { describe, it, expect } from 'vitest';
import { FixedClock, ok, type Mode, type Paise, type PositionId } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { UpstoxBroker } from './upstox.ts';
import type { BracketOrder, BrokerEvent } from './port.ts';

const P = (r: number) => Math.round(r * 100) as Paise;
const POS = 'pos_live' as PositionId;
const KEY = 'NSE_FO|50978';

const bracket: BracketOrder = {
  positionId: POS, instrumentKey: KEY, side: 'BUY', quantity: 65, product: 'I',
  entryTrigger: 'IMMEDIATE', entryPrice: P(100), targetPrice: P(130), stopLossPrice: P(80),
};

/** A scripted stand-in for the Upstox client: records calls, returns fixtures. */
function fakeClient(over: Partial<Record<keyof UpstoxClient, unknown>> = {}) {
  const calls: Array<{ fn: string; arg: unknown }> = [];
  const state = {
    rules: [] as Array<Record<string, unknown>>,
    book: [] as Array<Record<string, unknown>>,
  };
  const client = {
    placeGtt: async (b: unknown) => { calls.push({ fn: 'placeGtt', arg: b }); return ok({ status: 'success', data: { gtt_order_ids: ['GTT-1'] } }); },
    placeOrder: async (b: unknown) => { calls.push({ fn: 'placeOrder', arg: b }); return ok({ status: 'success', data: { order_ids: ['ORD-9'] } }); },
    cancelGtt: async (id: string) => { calls.push({ fn: 'cancelGtt', arg: id }); return ok({}); },
    getGtt: async () => ok([{ gtt_order_id: 'GTT-1', rules: state.rules }]),
    orderBook: async () => ok(state.book),
    exitAllPositions: async () => ok({ data: { order_ids: [] } }),
    ...over,
  } as unknown as UpstoxClient;
  return { client, calls, state };
}

function liveBroker(mode: Mode, client: UpstoxClient) {
  const dry: unknown[] = [];
  const b = new UpstoxBroker({
    client, clock: new FixedClock(new Date('2026-11-18T05:00:00Z')),
    modeGate: () => mode, onDryRun: (_k, p) => dry.push(p),
  });
  const events: BrokerEvent[] = [];
  b.onEvent((e) => events.push(e));
  return { b, events, dry };
}

describe('mode gate is read at the moment of every order write', () => {
  it.each(['PAPER', 'SANDBOX', 'LIVE_ARMED'] as const)('%s sends nothing and records a dry run', async (mode) => {
    const { client, calls } = fakeClient();
    const { b, dry } = liveBroker(mode, client);
    const r = await b.placeBracketOrder(bracket);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(dry).toHaveLength(1);
  });

  it('a gate that flips mid-session stops the very next order', async () => {
    const { client, calls } = fakeClient();
    let mode: Mode = 'LIVE';
    const b = new UpstoxBroker({ client, clock: new FixedClock(new Date()), modeGate: () => mode });
    expect((await b.placeBracketOrder(bracket)).ok).toBe(true);
    mode = 'LIVE_ARMED'; // arm expired
    expect((await b.placeBracketOrder({ ...bracket, positionId: 'pos_2' as PositionId })).ok).toBe(false);
    expect(calls.filter((c) => c.fn === 'placeGtt')).toHaveLength(1);
  });
});

describe('GTT MULTIPLE payload', () => {
  it('carries the mandatory ENTRY leg and uses the ENTRY side as transaction_type', async () => {
    const { client, calls } = fakeClient();
    const { b } = liveBroker('LIVE', client);
    await b.placeBracketOrder({ ...bracket, trailingGap: P(5) });
    const body = calls[0]!.arg as { transaction_type: string; rules: Array<{ strategy: string; trailing_gap?: number }> };
    expect(body.transaction_type).toBe('BUY');
    expect(body.rules.map((r) => r.strategy)).toEqual(['ENTRY', 'TARGET', 'STOPLOSS']);
    expect(body.rules[2]!.trailing_gap).toBe(5);
  });

  it('reads the id from gtt_order_ids[] and never invents one', async () => {
    const { client } = fakeClient();
    const { b } = liveBroker('LIVE', client);
    const r = await b.placeBracketOrder(bracket);
    expect(r.ok && r.value.gttOrderId).toBe('GTT-1');

    const { client: noId } = fakeClient({ placeGtt: async () => ok({ status: 'success', data: {} }) });
    const r2 = await liveBroker('LIVE', noId).b.placeBracketOrder(bracket);
    expect(r2.ok).toBe(false);
  });

  it('reads plain order ids from order_ids[]', async () => {
    const { client } = fakeClient();
    const { b } = liveBroker('LIVE', client);
    const r = await b.placeOrder({
      positionId: POS, instrumentKey: KEY, side: 'BUY', quantity: 65, orderType: 'MARKET',
      product: 'I', validity: 'DAY', price: P(0), triggerPrice: P(0), tag: 't',
    });
    expect(r.ok && r.value.brokerOrderId).toBe('ORD-9');
  });
});

describe('fills come from broker state, not from acknowledgements', () => {
  it('emits nothing until the entry order is complete in the order book', async () => {
    const { client, state } = fakeClient();
    const { b, events } = liveBroker('LIVE', client);
    await b.placeBracketOrder(bracket);
    state.rules = [{ strategy: 'ENTRY', status: 'TRIGGERED', order_id: 'E1' }];
    state.book = [{ order_id: 'E1', status: 'open', filled_quantity: 0 }];
    await b.sync();
    expect(events).toHaveLength(0);

    state.book = [{ order_id: 'E1', status: 'complete', filled_quantity: 65, average_price: 101.5 }];
    await b.sync();
    expect(events).toEqual([expect.objectContaining({ kind: 'ENTRY_FILLED', quantity: 65, avgPrice: P(101.5) })]);
  });

  it('reports the exit leg that filled, once', async () => {
    const { client, state } = fakeClient();
    const { b, events } = liveBroker('LIVE', client);
    await b.placeBracketOrder(bracket);
    state.rules = [
      { strategy: 'ENTRY', status: 'COMPLETED', order_id: 'E1' },
      { strategy: 'STOPLOSS', status: 'COMPLETED', order_id: 'S1' },
    ];
    state.book = [
      { order_id: 'E1', status: 'complete', filled_quantity: 65, average_price: 100 },
      { order_id: 'S1', status: 'complete', filled_quantity: 65, average_price: 79.5 },
    ];
    await b.sync();
    await b.sync();
    expect(events.map((e) => e.kind)).toEqual(['ENTRY_FILLED', 'EXIT_FILLED']);
    expect(events[1]).toMatchObject({ leg: 'STOPLOSS', avgPrice: P(79.5) });
  });

  it('calls a stop-out a stop-out when Upstox fills it through the TARGET leg', async () => {
    // Seen live on PNB: STOPLOSS leg CANCELLED with no order, TARGET leg's order
    // repriced to a protected limit and filled at the stop trigger.
    const { client, state } = fakeClient();
    const { b, events } = liveBroker('LIVE', client);
    await b.placeBracketOrder(bracket);
    state.rules = [
      { strategy: 'ENTRY', status: 'COMPLETED', order_id: 'E1', trigger_price: 100 },
      { strategy: 'STOPLOSS', status: 'CANCELLED', order_id: null, trigger_price: 80 },
      { strategy: 'TARGET', status: 'COMPLETED', order_id: 'T1', trigger_price: 130 },
    ];
    state.book = [
      { order_id: 'E1', status: 'complete', filled_quantity: 65, average_price: 100 },
      { order_id: 'T1', status: 'complete', filled_quantity: 65, average_price: 80.05 },
    ];
    await b.sync();
    expect(events[1]).toMatchObject({ kind: 'EXIT_FILLED', leg: 'STOPLOSS', avgPrice: P(80.05) });
  });

  it('reports a rejected entry so the engine does not wait on it forever', async () => {
    const { client, state } = fakeClient();
    const { b, events } = liveBroker('LIVE', client);
    await b.placeBracketOrder(bracket);
    state.rules = [{ strategy: 'ENTRY', status: 'FAILED', order_id: 'E1' }];
    state.book = [{ order_id: 'E1', status: 'rejected', filled_quantity: 0, status_message: 'insufficient funds' }];
    await b.sync();
    expect(events).toEqual([expect.objectContaining({ kind: 'ENTRY_FAILED', reason: 'insufficient funds' })]);
  });

  it('refuses to exit a position it never saw filled', async () => {
    const { client } = fakeClient();
    const { b } = liveBroker('LIVE', client);
    await b.placeBracketOrder(bracket);
    const r = await b.exitPosition({ positionId: POS, instrumentKey: KEY, side: 'SELL', quantity: 65, product: 'I' });
    expect(r.ok).toBe(false);
  });
});
