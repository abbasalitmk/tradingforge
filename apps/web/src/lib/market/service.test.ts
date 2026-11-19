import { describe, it, expect, vi } from 'vitest';
import type { Candle, Clock } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { AiReviewer } from '@tradeforger/ai';
import { DEFAULT_UNIVERSE } from '@tradeforger/strategy';
import { MarketService, MarketError } from './service.ts';
import { TtlCache } from './cache.ts';

const NOW = Date.parse('2026-11-19T07:00:00Z'); // 12:30 IST, a Thursday

function clockAt(ms: { t: number }): Clock {
  return { now: () => new Date(ms.t), ms: () => ms.t } as Clock;
}

/** A gently rising 5-minute series of `n` bars ending at `end`. */
function bars(n: number, end = NOW, base = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const p = base + i * 0.4;
    return { ts: end - (n - i) * 300_000, open: p, high: p + 0.6, low: p - 0.3, close: p + 0.3, volume: 1000 + i * 50 };
  });
}

const ok = <T>(value: T) => ({ ok: true as const, value });

function fakeClient(over: { intraday?: number; previous?: Candle[] } = {}) {
  const client = {
    quotes: vi.fn(async (keys: readonly string[]) =>
      ok(keys.map((k, i) => ({ instrument_token: k, last_price: 100 + i, net_change: 2, volume: 5000, ohlc: { open: 99, high: 103, low: 98 } })))),
    intradayCandles: vi.fn(async () => ok(bars(over.intraday ?? 40))),
    historicalCandles: vi.fn(async () => ok(over.previous ?? [])),
    optionChain: vi.fn(async () => ok([])),
    margin: vi.fn(async () => { throw new Error('margin needs the trading token'); }),
  };
  return client;
}

function service(client: ReturnType<typeof fakeClient>, t = { t: NOW }) {
  return new MarketService({
    client: client as unknown as UpstoxClient,
    clock: clockAt(t),
    ai: new AiReviewer({ groqConfig: null }),
    loadContracts: async () => [],
  });
}

describe('TtlCache', () => {
  it('reuses a value inside the TTL and shares in-flight loads', async () => {
    const t = { t: 0 };
    const cache = new TtlCache(() => t.t);
    const load = vi.fn(async () => 'v');
    await Promise.all([cache.get('k', 1000, load), cache.get('k', 1000, load)]);
    t.t = 999;
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
    t.t = 1000;
    await cache.get('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    const cache = new TtlCache(() => 0);
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    await expect(cache.get('k', 60_000, load)).rejects.toThrow('boom');
    await expect(cache.get('k', 60_000, load)).resolves.toBe('ok');
  });
});

describe('MarketService.overview', () => {
  it('ranks the universe and prices the watchlist from quotes', async () => {
    const client = fakeClient();
    const o = await service(client).overview();
    expect(o.watchlist).toHaveLength(DEFAULT_UNIVERSE.length);
    expect(o.rankedStocks).toHaveLength(DEFAULT_UNIVERSE.length);
    expect(o.rankedStocks.map((s) => s.rank)).toEqual(DEFAULT_UNIVERSE.map((_, i) => i + 1));
    expect(o.topStock).toEqual(o.rankedStocks[0]);
    expect(o.session).toEqual({ kind: 'today', date: '2026-11-19' });
    const first = o.watchlist[0]!;
    expect(first.ltp).toBe(100);
    expect(first.close).toBe(98);
    expect(first.changePct).toBeCloseTo((2 / 98) * 100);
    expect(first.bars).toBe(40);
    expect(client.historicalCandles).not.toHaveBeenCalled();
  });

  it('serves repeat polls from cache', async () => {
    const client = fakeClient();
    const m = service(client);
    await m.overview();
    await m.overview();
    expect(client.quotes).toHaveBeenCalledTimes(1);
    expect(client.intradayCandles).toHaveBeenCalledTimes(DEFAULT_UNIVERSE.length);
  });

  it('falls back to the last full session when today has too few bars', async () => {
    const yesterdayClose = NOW - 21 * 3_600_000; // 2026-11-18, 15:30 IST
    const earlier = bars(30, yesterdayClose - 86_400_000);
    const client = fakeClient({ intraday: 3, previous: [...earlier, ...bars(50, yesterdayClose)] });
    const o = await service(client).overview();
    expect(o.session).toEqual({ kind: 'previous', date: '2026-11-18' });
    expect(o.rankedStocks).toHaveLength(DEFAULT_UNIVERSE.length);
    // Only the last session's bars, never two days glued together.
    expect(o.watchlist[0]!.bars).toBe(50);
  });

  it('drops a stock whose candles fail instead of failing the page', async () => {
    const client = fakeClient();
    client.intradayCandles.mockImplementationOnce(async () => ({ ok: false, error: { message: 'timeout' } }) as never);
    const o = await service(client).overview();
    expect(o.rankedStocks).toHaveLength(DEFAULT_UNIVERSE.length - 1);
  });
});

describe('MarketService.analyzeStock', () => {
  it('returns the local model votes when Groq is not configured', async () => {
    const r = await service(fakeClient()).analyzeStock('reliance', 'INTRADAY');
    expect(r.stock.symbol).toBe('RELIANCE');
    expect(r.signal.style).toBe('INTRADAY');
    expect(r.votes.length).toBeGreaterThanOrEqual(3);
    expect(r.session.kind).toBe('today');
  });

  it('rejects a symbol outside the universe with 404', async () => {
    await expect(service(fakeClient()).analyzeStock('NOPE', 'INTRADAY')).rejects.toMatchObject({ status: 404, code: 'not_in_universe' });
  });

  it('reports too few bars as 404, not a crash', async () => {
    const e = await service(fakeClient({ intraday: 2 })).analyzeStock('TCS', 'SWING').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(MarketError);
    expect((e as MarketError).code).toBe('not_enough_bars');
  });
});

describe('MarketService F&O', () => {
  it('reports an underlying missing from the master without trading calls', async () => {
    const client = fakeClient();
    const m = service(client);
    const f = await m.fno();
    expect(f.underlyings).toHaveLength(2);
    const r = await m.analyzeFno('NIFTY');
    expect(r.plan).toBeNull();
    expect(r.rejected[0]).toMatch(/no tradeable F&O contracts/);
    expect(client.margin).not.toHaveBeenCalled();
  });

  it('rejects an unknown underlying with 404', async () => {
    await expect(service(fakeClient()).analyzeFno('XYZ')).rejects.toMatchObject({ status: 404, code: 'not_on_desk' });
  });
});
