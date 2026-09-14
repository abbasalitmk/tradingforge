import type { Clock } from '@tradeforger/core';

export interface BucketSpec {
  readonly perSecond: number;
  readonly perMinute: number;
  readonly per30Min: number;
}

/**
 * Upstox rate limits, verified against the live docs on 2026-09-14.
 *
 * ORDER covers place/modify/cancel/multi/GTT COMBINED — one bucket shared
 * across all five, never five separate ones. Upstox enforces the limit across
 * the category, so independent limiters would each believe they were compliant
 * while collectively breaching.
 */
export const ORDER_LIMITS: BucketSpec = { perSecond: 10, perMinute: 500, per30Min: 2000 };
export const STANDARD_LIMITS: BucketSpec = { perSecond: 50, perMinute: 500, per30Min: 2000 };

/**
 * Sliding-window limiter across three horizons simultaneously.
 *
 * A token-bucket would be cheaper, but Upstox enforces discrete windows and a
 * bucket's smoothing lets a burst pass that the real API would reject. Being
 * slightly conservative here costs a few milliseconds; being wrong costs a
 * temporary API suspension mid-session.
 */
export class RateLimiter {
  private hits: number[] = [];

  private readonly spec: BucketSpec;
  private readonly clock: Clock;
  private readonly name: string;

  constructor(spec: BucketSpec, clock: Clock, name = 'limiter') {
    this.spec = spec;
    this.clock = clock;
    this.name = name;
  }

  /** Milliseconds to wait before a call would be compliant. 0 means go now. */
  delayMs(): number {
    const now = this.clock.ms();
    this.prune(now);

    const waits = [
      this.waitFor(now, 1_000, this.spec.perSecond),
      this.waitFor(now, 60_000, this.spec.perMinute),
      this.waitFor(now, 1_800_000, this.spec.per30Min),
    ];
    return Math.max(0, ...waits);
  }

  private waitFor(now: number, windowMs: number, limit: number): number {
    const cutoff = now - windowMs;
    const inWindow = this.hits.filter((t) => t > cutoff);
    if (inWindow.length < limit) return 0;
    // Wait until the oldest hit in this window ages out.
    const oldest = inWindow[inWindow.length - limit];
    return oldest === undefined ? 0 : oldest + windowMs - now + 1;
  }

  /** Record a call. Must be called for every request that actually goes out. */
  record(): void {
    this.hits.push(this.clock.ms());
  }

  /** Block until compliant, then record. The only method callers should need. */
  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.delayMs();
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(wait, 1_000)));
    }
    this.record();
  }

  private prune(now: number): void {
    const cutoff = now - 1_800_000;
    if (this.hits.length > 4000) this.hits = this.hits.filter((t) => t > cutoff);
  }

  stats(): { name: string; lastSecond: number; lastMinute: number; last30Min: number } {
    const now = this.clock.ms();
    return {
      name: this.name,
      lastSecond: this.hits.filter((t) => t > now - 1_000).length,
      lastMinute: this.hits.filter((t) => t > now - 60_000).length,
      last30Min: this.hits.filter((t) => t > now - 1_800_000).length,
    };
  }
}
