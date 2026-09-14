import { type Clock, SystemClock, type Result, ok, err } from '@tradeforger/core';
import { RateLimiter, ORDER_LIMITS, STANDARD_LIMITS } from './ratelimit.ts';
import { UpstoxError, classify } from './errors.ts';

export const LIVE_BASE = 'https://api.upstox.com';
export const HFT_BASE = 'https://api-hft.upstox.com';
export const SANDBOX_BASE = 'https://api-sandbox.upstox.com';

/** Which shared limiter a call draws from. */
export type Category = 'order' | 'standard';

export interface TokenSource {
  /** Bearer token for trading-plane calls, or null when unauthenticated. */
  trading(): string | null;
  /** Read-only analytics token for the data plane. Falls back to trading token. */
  data(): string | null;
}

export interface HttpOptions {
  readonly baseUrl?: string;
  readonly clock?: Clock;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly onHalt?: (e: UpstoxError) => void;
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly category?: Category;
  /** 'data' uses the analytics token (no static-IP requirement); 'trading'
   *  uses the daily OAuth token and must come from the allowlisted IP. */
  readonly plane?: 'data' | 'trading';
}

/**
 * The single choke point for every Upstox call.
 *
 * Rate limiting, retry, error classification and token selection all live here
 * so there is exactly one place to audit them. Nothing else in the codebase is
 * permitted to call fetch() against Upstox.
 */
export class UpstoxHttp {
  private readonly orderLimiter: RateLimiter;
  private readonly standardLimiter: RateLimiter;
  private readonly clock: Clock;

  private readonly tokens: TokenSource;
  private readonly opts: HttpOptions;

  constructor(tokens: TokenSource, opts: HttpOptions = {}) {
    this.tokens = tokens;
    this.opts = opts;
    this.clock = opts.clock ?? SystemClock;
    this.orderLimiter = new RateLimiter(ORDER_LIMITS, this.clock, 'order');
    this.standardLimiter = new RateLimiter(STANDARD_LIMITS, this.clock, 'standard');
  }

  limiterStats() {
    return { order: this.orderLimiter.stats(), standard: this.standardLimiter.stats() };
  }

  async request<T>(path: string, o: RequestOptions = {}): Promise<Result<T, UpstoxError>> {
    const category = o.category ?? 'standard';
    const plane = o.plane ?? 'trading';
    const limiter = category === 'order' ? this.orderLimiter : this.standardLimiter;
    const maxRetries = this.opts.maxRetries ?? 2;

    const token = plane === 'data'
      ? (this.tokens.data() ?? this.tokens.trading())
      : this.tokens.trading();

    if (!token) {
      return err(new UpstoxError('TOKEN_INVALID', `no ${plane} token available`));
    }

    const url = new URL(path, this.opts.baseUrl ?? LIVE_BASE);
    for (const [k, v] of Object.entries(o.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    let lastError: UpstoxError | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await limiter.acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

      try {
        const res = await fetch(url, {
          method: o.method ?? 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${token}`,
            ...(o.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
          signal: controller.signal,
        });

        const text = await res.text();
        const parsed: unknown = text ? JSON.parse(text) : null;

        if (res.ok) return ok(parsed as T);

        lastError = classify(res.status, parsed);

        // A halting failure will not fix itself on retry — surface it now.
        if (lastError.shouldHalt) {
          this.opts.onHalt?.(lastError);
          return err(lastError);
        }
        if (!lastError.retryable || attempt === maxRetries) return err(lastError);

        await this.backoff(attempt);
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        lastError = new UpstoxError(
          aborted ? 'TIMEOUT' : 'NETWORK',
          e instanceof Error ? e.message : String(e),
        );
        if (attempt === maxRetries) return err(lastError);
        await this.backoff(attempt);
      } finally {
        clearTimeout(timer);
      }
    }

    return err(lastError ?? new UpstoxError('NETWORK', 'exhausted retries'));
  }

  /** Exponential backoff with jitter, so concurrent retries do not resynchronise. */
  private backoff(attempt: number): Promise<void> {
    const base = Math.min(2 ** attempt * 250, 4_000);
    return new Promise((r) => setTimeout(r, base + Math.random() * 250));
  }
}
