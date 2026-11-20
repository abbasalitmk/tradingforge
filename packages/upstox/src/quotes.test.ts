import { describe, it, expect } from 'vitest';
import { FixedClock } from '@tradeforger/core';
import { TokenStore } from './tokens.ts';
import { UpstoxClient } from './client.ts';

/** A client whose HTTP layer answers every request with `body`. */
function clientReturning(body: unknown): UpstoxClient {
  const c = new UpstoxClient(new TokenStore(new FixedClock(new Date('2026-11-20T07:00:00Z')), { analyticsToken: 'x' }));
  (c.http as unknown as { request: () => Promise<unknown> }).request = async () => ({ ok: true, value: body });
  return c;
}

describe('full quotes', () => {
  it('keeps every stock priced when an index in the same batch reports null volume', async () => {
    // As Upstox returned it on 2026-11-20: indices carry volume: null.
    const r = await clientReturning({
      status: 'success',
      data: {
        'NSE_EQ:RELIANCE': { instrument_token: 'NSE_EQ|INE002A01018', last_price: 1360.4, volume: 512_000, net_change: -4.1, ohlc: { open: 1366, high: 1368, low: 1355, close: 1360.4 } },
        'NSE_INDEX:Nifty 50': { instrument_token: 'NSE_INDEX|Nifty 50', last_price: 25_810.5, volume: null, net_change: 21.3, ohlc: { open: 25_790, high: 25_840, low: 25_760, close: 25_810.5 } },
      },
    }).quotes(['NSE_EQ|INE002A01018', 'NSE_INDEX|Nifty 50']);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.map((q) => q.last_price)).toEqual([1360.4, 25_810.5]);
  });

  it('drops only a malformed instrument, not the batch', async () => {
    const r = await clientReturning({
      status: 'success',
      data: {
        'NSE_EQ:TCS': { instrument_token: 'NSE_EQ|INE467B01029', last_price: 2398.5 },
        'NSE_EQ:BROKEN': { instrument_token: 'NSE_EQ|X', last_price: null },
      },
    }).quotes(['NSE_EQ|INE467B01029', 'NSE_EQ|X']);
    expect(r.ok && r.value.map((q) => q.instrument_token)).toEqual(['NSE_EQ|INE467B01029']);
  });

  it('still fails loudly when nothing in the response is usable', async () => {
    const r = await clientReturning({ status: 'success', data: { 'NSE_EQ:BROKEN': { last_price: 'n/a' } } }).quotes(['NSE_EQ|X']);
    expect(r.ok).toBe(false);
  });
});
