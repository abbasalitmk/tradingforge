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

/**
 * Upstox returns candles NEWEST FIRST (verified live 2026-11-18). Everything
 * downstream — indicators, the ORB, "last price" — assumes oldest first, so the
 * order is normalised here, at the one place candles enter the system.
 */
export const toCandles = (rows: readonly S.CandleTuple[]): Candle[] =>
  rows
    .map((r) => ({
      ts: new Date(r[0]).getTime(),
      open: r[1], high: r[2], low: r[3], close: r[4],
      volume: r[5], oi: r[6],
    }))
    .sort((a, b) => a.ts - b.ts);

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
 * Every order-category call draws from the shared 8/sec bucket.
 */
export class UpstoxClient {
  readonly http: UpstoxHttp;
  readonly tokens: TokenSource;

  constructor(tokens: TokenSource, opts: HttpOptions = {}) {
    this.tokens = tokens;
    this.http = new UpstoxHttp(tokens, opts);
  }

  /**
   * OAuth 2.0 Code-to-Token Exchange against Upstox login API.
   */
  async exchangeToken(params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<Result<{ accessToken: string; userProfile?: unknown }, UpstoxError>> {
    const form = new URLSearchParams({
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    });

    try {
      const res = await fetch('https://api.upstox.com/v2/login/authorization/token', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });

      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        return err(new UpstoxError('BAD_REQUEST', `Token exchange failed: ${res.statusText}`, res.status, undefined, body));
      }

      const data = body as { access_token?: string; user_id?: string; user_name?: string };
      if (!data.access_token) {
        return err(new UpstoxError('BAD_REQUEST', 'No access_token returned in token response', res.status, undefined, body));
      }

      return ok({
        accessToken: data.access_token,
        userProfile: data,
      });
    } catch (e) {
      return err(new UpstoxError('NETWORK', e instanceof Error ? e.message : String(e)));
    }
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

  /**
   * Full quotes (OHLC, volume, net change) for up to 500 instruments. The
   * scanner's coarse stage runs the whole universe through this in ~20 calls.
   */
  async quotes(instrumentKeys: readonly string[]): Promise<Result<S.FullQuote[], UpstoxError>> {
    if (instrumentKeys.length === 0) return ok([]);
    if (instrumentKeys.length > 500) {
      return err(new UpstoxError('BAD_REQUEST', `${instrumentKeys.length} keys exceeds the 500 limit`));
    }
    const r = await this.http.request<unknown>('/v2/market-quote/quotes', {
      query: { instrument_key: instrumentKeys.join(',') },
      plane: 'data',
    });
    if (!r.ok) return r;
    const env = S.quoteEnvelope.safeParse(r.value);
    if (!env.success) return err(new UpstoxError('BAD_REQUEST', `unexpected quote shape: ${env.error.message}`));
    // Validate per instrument: one odd entry (an index with null volume, a
    // suspended stock) must never cost every other instrument its price.
    const out: S.FullQuote[] = [];
    const bad: string[] = [];
    for (const [key, raw] of Object.entries(env.data.data)) {
      const q = S.fullQuote.safeParse(raw);
      if (q.success) out.push(q.data);
      else bad.push(`${key}: ${q.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join(', ')}`);
    }
    if (out.length === 0 && bad.length > 0) {
      return err(new UpstoxError('BAD_REQUEST', `unexpected quote shape: ${bad.slice(0, 3).join('; ')}`));
    }
    if (bad.length > 0) console.warn(`[upstox] skipped ${bad.length} malformed quote(s): ${bad.slice(0, 3).join('; ')}`);
    return ok(out);
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
    const plane = this.tokens.trading() ? 'trading' : 'data';
    const r = await this.http.request<unknown>('/v3/feed/market-data-feed/authorize', { plane });
    if (!r.ok) return r;
    const parsed = S.wsAuthorizeResponse.safeParse(r.value);
    const uri = parsed.success
      ? (parsed.data.data.authorizedRedirectUri ?? parsed.data.data.authorized_redirect_uri)
      : undefined;
    return uri ? ok(uri) : err(new UpstoxError('BAD_REQUEST', 'no authorized redirect URI in response'));
  }

  /**
   * Full option chain for one underlying and expiry: per-strike LTP, bid/ask,
   * OI, previous OI and greeks for both the call and the put.
   */
  async optionChain(
    underlyingKey: string,
    expiryDate: string,
  ): Promise<Result<S.OptionStrike[], UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/option/chain', {
      query: { instrument_key: underlyingKey, expiry_date: expiryDate },
      plane: 'data',
    });
    if (!r.ok) return r;
    const parsed = S.optionChainResponse.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.data)
      : err(new UpstoxError('BAD_REQUEST', `unexpected option chain shape: ${parsed.error.message}`));
  }

  // ──────────────────────────── trading plane ────────────────────────────
  // All of the below require the account's allowlisted static IP.

  async funds(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/user/get-funds-and-margin', { plane: 'trading' });
  }

  async profile(): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v2/user/profile', { plane: 'trading' });
  }

  async positions(): Promise<Result<S.PositionEntry[], UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/portfolio/short-term-positions', { plane: 'trading' });
    if (!r.ok) return r;
    const parsed = S.positionsResponse.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.data)
      : err(new UpstoxError('BAD_REQUEST', `unexpected positions shape: ${parsed.error.message}`));
  }

  async orderBook(): Promise<Result<S.OrderBookEntry[], UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/order/retrieve-all', { plane: 'trading' });
    if (!r.ok) return r;
    const parsed = S.orderBookEntries.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.data)
      : err(new UpstoxError('BAD_REQUEST', `unexpected order book shape: ${parsed.error.message}`));
  }

  /** Exchange margin for a prospective order — what a futures lot actually locks up. */
  async margin(instruments: ReadonlyArray<{
    instrument_key: string; quantity: number; product: string; transaction_type: string; price?: number;
  }>): Promise<Result<{ requiredMargin: number; finalMargin: number }, UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/charges/margin', {
      method: 'POST', body: { instruments }, plane: 'trading',
    });
    if (!r.ok) return r;
    const parsed = S.marginResponse.safeParse(r.value);
    if (!parsed.success) {
      return err(new UpstoxError('BAD_REQUEST', `unexpected margin shape: ${parsed.error.message}`));
    }
    const d = parsed.data.data;
    return ok({ requiredMargin: d.required_margin ?? 0, finalMargin: d.final_margin ?? d.required_margin ?? 0 });
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

  /** The v3 cancel takes the id in a JSON body, not the query string. */
  async cancelGtt(gttOrderId: string): Promise<Result<unknown, UpstoxError>> {
    return this.http.request('/v3/order/gtt/cancel', {
      method: 'DELETE', body: { gtt_order_id: gttOrderId }, category: 'order', plane: 'trading',
    });
  }

  async getGtt(gttOrderId?: string): Promise<Result<S.GttDetail[], UpstoxError>> {
    const r = await this.http.request<unknown>('/v3/order/gtt', {
      query: gttOrderId ? { gtt_order_id: gttOrderId } : {}, plane: 'trading',
    });
    if (!r.ok) return r;
    const parsed = S.gttDetailResponse.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.data)
      : err(new UpstoxError('BAD_REQUEST', `unexpected GTT shape: ${parsed.error.message}`));
  }

  /** Authorized wss:// URL for the JSON portfolio stream (orders, GTTs, positions). */
  async portfolioFeedUrl(): Promise<Result<string, UpstoxError>> {
    const r = await this.http.request<unknown>('/v2/feed/portfolio-stream-feed/authorize', {
      query: { update_types: 'order,gtt_order,position,holding' },
      plane: 'trading',
    });
    if (!r.ok) return r;
    const parsed = S.wsAuthorizeResponse.safeParse(r.value);
    const uri = parsed.success
      ? (parsed.data.data.authorizedRedirectUri ?? parsed.data.data.authorized_redirect_uri)
      : undefined;
    return uri ? ok(uri) : err(new UpstoxError('BAD_REQUEST', 'no authorized redirect URI in response'));
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
