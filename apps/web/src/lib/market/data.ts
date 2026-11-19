import { type Candle, type Clock, istDateKey } from '@tradeforger/core';
import type { UpstoxClient, UpstoxError, schemas } from '@tradeforger/upstox';
import {
  fetchMasterRows, parseMaster, parseEquities, type DerivativeContract, type EquityInstrument,
} from '@tradeforger/fno';
import { TtlCache } from './cache.ts';

const DAY = 86_400_000;
/** The scanner needs this many 5-minute bars before it will score a stock. */
export const MIN_BARS = 15;

const TTL = {
  quotes: 5_000,
  intraday: 30_000,
  oneMinute: 10_000,
  history: 30 * 60_000,
  daily: 30 * 60_000,
} as const;

export class MarketError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Which session the bars came from: today's, or the last full one when today has too few. */
export interface Session {
  readonly kind: 'today' | 'previous';
  readonly date: string;
}

export interface Bars {
  readonly candles: readonly Candle[];
  readonly session: Session;
}

export interface Master {
  readonly contracts: readonly DerivativeContract[];
  readonly equities: readonly EquityInstrument[];
  readonly bySymbol: ReadonlyMap<string, EquityInstrument>;
}

/** An Upstox failure as the dashboard should see it; rate limits get their own status. */
export function upstoxFailure(what: string, e: UpstoxError): MarketError {
  return e.kind === 'RATE_LIMITED' || e.status === 429
    ? new MarketError(429, 'rate_limited', 'Upstox rate limit reached; try again in a minute')
    : new MarketError(502, `upstox_${what}`, `Upstox ${what}: ${e.message}`);
}

/** Merge candle arrays by timestamp; later sources win. */
export function mergeCandles(...sources: ReadonlyArray<readonly Candle[]>): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const src of sources) for (const c of src) byTs.set(c.ts, c);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Upstox market data for the dashboard, cached per serverless instance.
 * Analytics token only: nothing here can reach the order plane.
 */
export class MarketData {
  readonly client: UpstoxClient;
  readonly clock: Clock;
  readonly cache: TtlCache;
  private readonly loadMasterRows: () => Promise<readonly unknown[]>;

  constructor(client: UpstoxClient, clock: Clock, loadMasterRows: () => Promise<readonly unknown[]> = fetchMasterRows) {
    this.client = client;
    this.clock = clock;
    this.cache = new TtlCache(() => clock.ms());
    this.loadMasterRows = loadMasterRows;
  }

  private day(offset = 0): string {
    return istDateKey(new Date(this.clock.ms() + offset * DAY));
  }

  /** The instrument master, parsed once per IST day (contracts expire, listings change). */
  master(): Promise<Master> {
    return this.cache.get(`master:${this.day()}`, Number.POSITIVE_INFINITY, async () => {
      const rows = await this.loadMasterRows();
      const equities = parseEquities(rows);
      return { contracts: parseMaster(rows), equities, bySymbol: new Map(equities.map((e) => [e.symbol, e])) };
    });
  }

  /** Full quotes keyed by instrument key, 500 per Upstox call. */
  async quotes(keys: readonly string[]): Promise<Map<string, schemas.FullQuote>> {
    const out = new Map<string, schemas.FullQuote>();
    for (let i = 0; i < keys.length; i += 500) {
      const batch = keys.slice(i, i + 500);
      const got = await this.cache.get(`quotes:${batch.join(',')}`, TTL.quotes, async () => {
        const r = await this.client.quotes(batch);
        if (!r.ok) throw upstoxFailure('quotes', r.error);
        return r.value;
      });
      for (const q of got) out.set(q.instrument_token, q);
    }
    return out;
  }

  private candles(cacheKey: string, ttl: number, load: () => ReturnType<UpstoxClient['intradayCandles']>): Promise<Candle[]> {
    return this.cache.get(cacheKey, ttl, async () => {
      const r = await load();
      if (!r.ok) throw upstoxFailure('candles', r.error);
      return r.value;
    });
  }

  /** Today's closed 5-minute bars. */
  intraday(key: string): Promise<Candle[]> {
    return this.candles(`intraday:${key}`, TTL.intraday, () => this.client.intradayCandles(key, 'minutes', 5));
  }

  /** Prior sessions' 5-minute bars, for indicator warmup. */
  history(key: string): Promise<Candle[]> {
    return this.candles(`history:${key}:${this.day()}`, TTL.history,
      () => this.client.historicalCandles(key, 'minutes', 5, this.day(-1), this.day(-8)));
  }

  /** About a year and a half of daily bars. */
  daily(key: string): Promise<Candle[]> {
    return this.candles(`daily:${key}:${this.day()}`, TTL.daily,
      () => this.client.historicalCandles(key, 'days', 1, this.day(), this.day(-400)));
  }

  /**
   * The still-forming 5-minute bar, built from the current bucket's closed
   * 1-minute bars and the live price. Upstox's 5-minute series only carries
   * closed bars, so without this a "realtime" view lags by up to five minutes.
   */
  async formingBar(key: string, ltp: number | null): Promise<Candle | null> {
    const bucket = Math.floor(this.clock.ms() / 300_000) * 300_000;
    const ones = (await this.candles(`1m:${key}`, TTL.oneMinute, () => this.client.intradayCandles(key, 'minutes', 1)))
      .filter((c) => c.ts >= bucket);
    if (ones.length === 0 && ltp === null) return null;
    const first = ones[0];
    const prices = [...ones.flatMap((c) => [c.high, c.low]), ...(ltp !== null ? [ltp] : [])];
    return {
      ts: bucket,
      open: first?.open ?? ltp!,
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: ltp ?? ones.at(-1)!.close,
      volume: ones.reduce((a, c) => a + c.volume, 0),
    };
  }

  /**
   * Bars to rank on. Before ~10:30, at weekends and on holidays today has too
   * few, so the last full session is used instead, and labelled as such.
   */
  async rankingBars(key: string): Promise<Bars> {
    const today = this.day();
    const intra = await this.intraday(key);
    if (intra.length >= MIN_BARS) return { candles: intra, session: { kind: 'today', date: today } };
    const hist = await this.history(key);
    const last = hist.at(-1);
    if (!last) return { candles: intra, session: { kind: 'today', date: today } };
    const date = istDateKey(new Date(last.ts));
    return {
      candles: hist.filter((c) => istDateKey(new Date(c.ts)) === date),
      session: { kind: 'previous', date },
    };
  }
}
