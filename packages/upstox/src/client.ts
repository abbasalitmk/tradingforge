import { type Result, ok, err, type Candle, type Instrument } from '@tradeforger/core';
import { UpstoxHttp, type TokenSource, type HttpOptions } from './http.ts';
import { UpstoxError } from './errors.ts';
import * as S from './schemas.ts';

export type Unit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

/**
 * Maximum span per historical-candle request, per Upstox's V3 limits.
 * Exceeding these returns an "invalid request" error rather than truncating,
 * so the backfill planner must chunk against this table.
 */
export const MAX_SPAN_DAYS: Record<Unit, (interval: number) => number> = {
  minutes: (i) => (i <= 15 ? 30 : 90),
  hours: () => 90,
  days: () => 3650,
  weeks: () => 36500,
  months: () => 36500,
};

/** Earliest data Upstox holds, by unit. */
export const HISTORY_FROM: Record<Unit, string> = {
  minutes: '2022-01-01',
  hours: '2022-01-01',
  days: '2000-01-01',
  weeks: '2000-01-01',
  months: '2000-01-01',
};

const toCandles = (rows: readonly S.CandleTuple[]): Candle[] =>
  rows.map((r) => ({
    ts: new Date(r[0]).getTime(),
    open: r[1], high: r[2], low: r[3], close: r[4],
    volume: r[5], oi: r[6],
  }));

/**
 * Typed Upstox client.
 *
 * Methods are grouped by PLANE, and the distinction is load-bearing:
 *
 *   data()    — quotes, candles, instruments, feed authorize. Uses the
 *               analytics token. Works from any IP.
 *   trading() — funds, positions, orders, GTT, kill switch. Uses the daily
 *               OAuth token and returns UDAPI1221 unless the request comes
 *               from the account's allowlisted static IP.
 *
 * Every order-category call draws from the shared 10/sec bucket.
 */
export class UpstoxClient {
  readonly http: UpstoxHttp;

  constructor(tokens: TokenSource, opts: HttpOptions = {}) {
    this.http = new UpstoxHttp(tokens, opts);
  }

  // ───────────────────────────── data plane ─────────────────────────────

  /** Batch LTP. Upstox accepts up to 500 instrument keys per call. */
  async ltp(instrumentKeys: readonly string[]): Promise<Result<Record<string, S.LtpQuote>, UpstoxError>> {
    if (instrumentKeys.length === 0) return ok({});
    if (instrumentKeys.length > 500) {
      return err(new UpstoxError('BAD_REQUEST', `${instrumentKeys.length} keys exceeds the 500 limit`));
    }
    const r = await this.http.request<unknown>('/v3/market-quote/ltp', {
      query: { instrument_key: instrumentKeys.join(',') },
      plane: 'data',
    });
    if (!r.ok) return r;
    const parsed = S.ltpResponse.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.data)
      : err(new UpstoxError('BAD_REQUEST', `unexpected LTP shape: ${parsed.error.message}`));
  }

  async historicalCandles(
    instrumentKey: string,
    unit: Unit,
    interval: number,
    toDate: string,
    fromDate: string,
  ): Promise<Result<Candle[], UpstoxError>> {
    const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${toDate}/${fromDate}`;
    const r = await this.http.request<unknown>(path, { plane: 'data' });
    if (!r.ok) return r;
    const parsed = S.candlesResponse.safeParse(r.value);
    return parsed.success
      ? ok(toCandles(parsed.data.data.candles))
      : err(new UpstoxError('BAD_REQUEST', `unexpected candle shape: ${parsed.error.message}`));
  }

  async intradayCandles(
    instrumentKey: string,
    unit: Unit,
    interval: number,
  ): Promise<Result<Candle[], UpstoxError>> {
    const path = `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`;
    const r = await this.http.request<unknown>(path, { plane: 'data' });
    if (!r.ok) return r;
    const parsed = S.candlesResponse.safeParse(r.value);
    return parsed.success
      ? ok(toCandles(parsed.data.data.candles))
      : err(new UpstoxError('BAD_REQUEST', `unexpected candle shape: ${parsed.error.message}`));
  }

  async searchInstruments(
    query: string,
    opts: { exchanges?: string; segments?: string } = {},
  ): Promise<Result<Instrument[], UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/instruments/search', {
      query: { query, exchanges: opts.exchanges, segments: opts.segments },
      plane: 'data',
    });
    if (!r.ok) return r;
    const parsed = S.instrumentSearchResponse.safeParse(r.value);
    if (!parsed.success) {
      return err(new UpstoxError('BAD_REQUEST', `unexpected search shape: ${parsed.error.message}`));
    }
    return ok(parsed.data.data.map((i): Instrument => ({
      instrumentKey: i.instrument_key,
      tradingSymbol: i.trading_symbol ?? i.name,
      name: i.name,
      exchange: i.exchange,
      segment: i.segment,
      isin: i.isin ?? null,
      lotSize: i.lot_size ?? 1,
      tickSize: i.tick_size ?? 0.05,
    })));
  }

  /** Authorized wss:// URL for the V3 protobuf market feed. */
  async marketFeedUrl(): Promise<Result<string, UpstoxError>> {
    const r = await this.http.request<unknown>('/v3/feed/market-data-feed/authorize', { plane: 'data' });
    if (!r.ok) return r;
    const parsed = S.wsAuthorizeResponse.safeParse(r.value);
    const uri = parsed.success
      ? (parsed.data.data.authorizedRedirectUri ?? parsed.data.data.authorized_redirect_uri)
      : undefined;
    return uri ? ok(uri) : err(new UpstoxError('BAD_REQUEST', 'no authorized redirect URI in response'));
  }

  // ──────────────────────────── trading plane ────────────────────────────
  // All of the below require the account's allowlisted static IP.

  async funds(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/user/get-funds-and-margin', { plane: 'trading' });
  }

  async profile(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/user/profile', { plane: 'trading' });
  }

  async positions(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/portfolio/short-term-positions', { plane: 'trading' });
  }

  async orderBook(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/order/retrieve-all', { plane: 'trading' });
  }

  async placeOrder(body: Record<string, unknown>): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/place', {
      method: 'POST', body, category: 'order', plane: 'trading',
    });
  }

  async modifyOrder(body: Record<string, unknown>): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/modify', {
      method: 'PUT', body, category: 'order', plane: 'trading',
    });
  }

  async cancelOrder(orderId: string): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/cancel', {
      method: 'DELETE', query: { order_id: orderId }, category: 'order', plane: 'trading',
    });
  }

  /** GTT MULTIPLE is the native bracket — see docs/00-PLAN.md §0.1. */
  async placeGtt(body: Record<string, unknown>): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/gtt/place', {
      method: 'POST', body, category: 'order', plane: 'trading',
    });
  }

  async cancelGtt(gttOrderId: string): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/gtt/cancel', {
      method: 'DELETE', query: { gtt_order_id: gttOrderId }, category: 'order', plane: 'trading',
    });
  }

  async getGtt(gttOrderId?: string): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/gtt', {
      query: gttOrderId ? { gtt_order_id: gttOrderId } : {}, plane: 'trading',
    });
  }

  async exitAllPositions(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/order/positions/exit', {
      method: 'POST', body: {}, category: 'order', plane: 'trading',
    });
  }

  async killSwitch(segment: string, action: 'ENABLE' | 'DISABLE'): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/user/kill-switch', {
      method: 'POST', body: { segment, action }, plane: 'trading',
    });
  }

  /** Static-IP allowlist management — see docs/00-PLAN.md §6.3. */
  async getAllowlistedIp(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/user/ip', { plane: 'trading' });
  }
}
