import { describe, it, expect, vi } from 'vitest';
import type { Candle, Clock } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { AiReviewer } from '@tradeforger/ai';
import { STRATEGY_CATALOG } from '@tradeforger/strategy';
import { daily as dailySeries, intraday as intradaySeries } from '../../../../../packages/strategy/src/fixtures.ts';
import { MarketService, MarketError } from './service.ts';
import { INDEX_CATEGORIES, parseConstituents, snapshotConstituents, type IndexList } from './indices.ts';

// 16:00 IST on a weekday: market closed, so no forming bar and no intraday entries.
const NOW = Date.parse('2026-01-07T10:30:00Z');
const clock: Clock = { now: () => new Date(NOW), ms: () => NOW } as Clock;

const STOCKS = [
  { symbol: 'ALPHA', price: 150, drift: 0.003 },
  { symbol: 'BETA', price: 420, drift: 0.002 },
  { symbol: 'GAMMA', price: 2600, drift: 0.002 },
  { symbol: 'DELTA', price: 90, drift: -0.002 },
];
const keyOf = (s: string) => `NSE_EQ|INE${s}`;
const masterRows = [
  ...STOCKS.map((s) => ({ segment: 'NSE_EQ', instrument_type: 'EQ', instrument_key: keyOf(s.symbol), trading_symbol: s.symbol, name: `${s.symbol} Ltd` })),
  { segment: 'NSE_EQ', instrument_type: 'EQ', instrument_key: keyOf('ALPHAX'), trading_symbol: 'ALPHAX', name: 'Alpha Extra Ltd' },
];
const dailyBars = new Map(STOCKS.map((s, i) => [keyOf(s.symbol), dailySeries('2024-06-03', 400, { seed: i + 1, start: s.price, drift: s.drift, vol: 0.015, volume: 1e6 })]));
const fiveMin = new Map(STOCKS.map((s, i) => [keyOf(s.symbol), intradaySeries('2025-12-01', 26, { seed: i + 7, start: s.price, drift: s.drift / 4, vol: 0.003, volume: 20_000 })]));

const ok = <T>(value: T) => ({ ok: true as const, value });
const rateLimited = { ok: false as const, error: { kind: 'RATE_LIMITED', status: 429, message: 'HTTP 429' } };

function fakeClient(over: { candlesFail?: boolean; backfillFailOnce?: boolean } = {}) {
  let backfillFails = over.backfillFailOnce ? 1 : 0;
  return {
    quotes: vi.fn(async (keys: readonly string[]) => ok(keys.flatMap((k) => {
      const bars = dailyBars.get(k);
      const last = bars?.at(-1);
      if (!last) return [];
      return [{ instrument_token: k, last_price: last.close, net_change: last.close - bars!.at(-2)!.close, volume: 2e6, ohlc: { open: last.open, high: last.high, low: last.low } }];
    }))),
    intradayCandles: vi.fn(async () => (over.candlesFail ? rateLimited : ok([] as Candle[]))),
    historicalCandles: vi.fn(async (key: string, unit: string) => {
      if (over.candlesFail) return rateLimited;
      if (unit === 'days') return ok(dailyBars.get(key) ?? []);
      if (backfillFails > 0) { backfillFails--; return rateLimited; }
      return ok(fiveMin.get(key) ?? []);
    }),
    optionChain: vi.fn(),
    margin: vi.fn(() => { throw new Error('margin needs the trading token'); }),
  };
}

const index: IndexList = {
  category: INDEX_CATEGORIES[0]!,
  constituents: STOCKS.map((s) => ({ symbol: s.symbol, name: `${s.symbol} Ltd`, industry: 'Testing', isin: `INE${s.symbol}`, instrumentKey: keyOf(s.symbol) })),
  source: 'live',
};

function service(client = fakeClient()) {
  return new MarketService({
    client: client as unknown as UpstoxClient,
    clock,
    ai: new AiReviewer({ groqConfig: null }),
    loadMasterRows: async () => masterRows,
    loadIndex: async () => index,
  });
}

describe('index lists', () => {
  it('parses NSE constituent CSVs, quoted fields included, EQ series only', () => {
    const csv = 'Company Name,Industry,Symbol,Series,ISIN Code\n"Mahindra, & Co",Automobile,M&M,EQ,INE101A01026\nX Ltd,Metals,XBE,BE,INE000X01010\n';
    expect(parseConstituents(csv)).toEqual([
      { symbol: 'M&M', name: 'Mahindra, & Co', industry: 'Automobile', isin: 'INE101A01026', instrumentKey: 'NSE_EQ|INE101A01026' },
    ]);
  });

  it('has a snapshot for every category', () => {
    for (const c of INDEX_CATEGORIES) expect(snapshotConstituents(c.id).length, c.id).toBeGreaterThan(0);
    expect(snapshotConstituents('NIFTY50')).toHaveLength(50);
  });
});

describe('MarketService.search', () => {
  it('puts exact and prefix symbol matches first', async () => {
    const { results } = await service().search('alpha');
    expect(results.map((r) => r.symbol)).toEqual(['ALPHA', 'ALPHAX']);
  });

  it('matches on company name too', async () => {
    const { results } = await service().search('extra');
    expect(results.map((r) => r.symbol)).toEqual(['ALPHAX']);
  });
});

describe('MarketService.scan', () => {
  it('scans an index with every strategy, ranked by quality, with industry and list source', async () => {
    const r = await service().scan({ category: 'NIFTY50', filters: { style: 'SWING' } });
    expect(r.listSource).toBe('live');
    expect(r.universe).toBe(4);
    expect(r.quoted).toBe(4);
    expect(r.warnings).toEqual([]);
    expect(r.results.length).toBeGreaterThan(0);
    const q = r.results.map((x) => x.setup.quality);
    expect(q).toEqual([...q].sort((a, b) => b - a));
    expect(r.results.every((x) => x.industry === 'Testing' && x.setup.style === 'SWING')).toBe(true);
  });

  it('applies the price band before fetching candles', async () => {
    const client = fakeClient();
    const r = await service(client).scan({ category: 'NIFTY50', filters: { minPrice: 100, maxPrice: 1000 } });
    const lastPrice = (s: string) => dailyBars.get(keyOf(s))!.at(-1)!.close;
    const inBand = STOCKS.filter((s) => lastPrice(s.symbol) >= 100 && lastPrice(s.symbol) <= 1000).map((s) => keyOf(s.symbol));
    expect(inBand.length).toBeGreaterThan(0);
    expect(inBand.length).toBeLessThan(STOCKS.length);
    expect(r.shortlisted).toBe(inBand.length);
    expect(r.results.every((x) => x.ltp >= 100 && x.ltp <= 1000)).toBe(true);
    const fetched = new Set(client.historicalCandles.mock.calls.map((c) => c[0]));
    expect([...fetched].sort()).toEqual([...inBand].sort());
  });

  it('scans the whole market from the instrument master', async () => {
    const r = await service().scan({ category: 'ALL', filters: {} });
    expect(r.listSource).toBe('Upstox instrument master');
    expect(r.universe).toBe(masterRows.length);
  });

  it('rejects an unknown category', async () => {
    await expect(service().scan({ category: 'NOPE', filters: {} })).rejects.toMatchObject({ status: 404 });
  });

  it('reports an Upstox rate limit instead of returning an empty scan', async () => {
    await expect(service(fakeClient({ candlesFail: true })).scan({ category: 'NIFTY50', filters: {} }))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('only runs the strategies asked for', async () => {
    const r = await service().scan({ category: 'NIFTY50', filters: { strategies: ['EMA_TREND_SWING'] } });
    for (const x of r.results) expect(x.setup.votes.map((v) => v.strategyId)).toEqual(['EMA_TREND_SWING']);
  });
});

describe('MarketService.stock', () => {
  it('returns every strategy vote, setups and indicators for one stock', async () => {
    const r = await service().stock('alpha');
    expect(r.symbol).toBe('ALPHA');
    expect(r.marketOpen).toBe(false);
    expect(r.bars.forming).toBe(false);
    expect(r.votes.map((v) => v.strategyId)).toEqual(STRATEGY_CATALOG.map((d) => d.id));
    expect(r.indicators.daily.trend).toMatch(/UPTREND|MIXED|DOWNTREND/);
    expect(r.quote.ltp).toBeGreaterThan(0);
  });

  it('rejects a symbol that is not an NSE stock', async () => {
    await expect(service().stock('NOPE')).rejects.toBeInstanceOf(MarketError);
  });

  it('surfaces a rate limit rather than an empty analysis', async () => {
    await expect(service(fakeClient({ candlesFail: true })).stock('ALPHA')).rejects.toMatchObject({ status: 429 });
  });
});

describe('MarketService.stockEdge', () => {
  it('backtests every strategy on the stock', async () => {
    const r = await service().stockEdge('BETA');
    expect(r.edges.map((e) => e.strategyId)).toEqual(STRATEGY_CATALOG.map((d) => d.id));
    expect(r.edges.some((e) => (e.trades ?? 0) > 0)).toBe(true);
  }, 15_000);

  it('fails visibly on a rate limit and does not cache the failure', async () => {
    const m = service(fakeClient({ backfillFailOnce: true }));
    await expect(m.stockEdge('BETA')).rejects.toMatchObject({ status: 429 });
    await expect(m.stockEdge('BETA')).resolves.toHaveProperty('edges');
  });
});

describe('MarketService.stockAi', () => {
  it('explains when there is no setup to review', async () => {
    const r = await service().stockAi('ALPHA', ['ORB_SUPERTREND']);
    expect(r.consensus).toBeNull();
    expect(r.reason).toMatch(/No strategy/);
  });
});
