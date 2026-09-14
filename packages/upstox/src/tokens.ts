import type { Clock } from '@tradeforger/core';

/**
 * Token lifecycle.
 *
 * Upstox access tokens expire at 03:30 IST daily regardless of when they were
 * issued — an 03:00 token is dead in 30 minutes. Anything that assumes a
 * rolling 24h validity will fail at the worst possible moment, so expiry is
 * computed from the wall clock, never from issue time.
 */
export interface TokenSet {
  readonly tradingToken: string | null;
  readonly tradingExpiresAtMs: number | null;
  /** Analytics token: read-only, ~1y validity, no static-IP requirement.
   *  Serves the entire data plane so the daily token is reserved for trading. */
  readonly analyticsToken: string | null;
}

/** Next 03:30 IST strictly after `from`. */
export function nextTokenExpiry(from: Date): number {
  const IST = 330 * 60_000;
  const ist = new Date(from.getTime() + IST);
  const expiry = new Date(ist);
  expiry.setUTCHours(3, 30, 0, 0);
  if (expiry.getTime() <= ist.getTime()) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.getTime() - IST;
}

export class TokenStore {
  private set: TokenSet;

  private readonly clock: Clock;

  constructor(clock: Clock, initial: Partial<TokenSet> = {}) {
    this.clock = clock;
    this.set = {
      tradingToken: initial.tradingToken ?? null,
      tradingExpiresAtMs: initial.tradingExpiresAtMs ?? null,
      analyticsToken: initial.analyticsToken ?? null,
    };
  }

  /** Returns null once expired, so callers cannot accidentally use a dead token. */
  trading(): string | null {
    if (!this.set.tradingToken) return null;
    if (this.set.tradingExpiresAtMs !== null && this.clock.ms() >= this.set.tradingExpiresAtMs) {
      return null;
    }
    return this.set.tradingToken;
  }

  data(): string | null {
    return this.set.analyticsToken;
  }

  setTrading(token: string): void {
    this.set = {
      ...this.set,
      tradingToken: token,
      tradingExpiresAtMs: nextTokenExpiry(this.clock.now()),
    };
  }

  setAnalytics(token: string): void {
    this.set = { ...this.set, analyticsToken: token };
  }

  clearTrading(): void {
    this.set = { ...this.set, tradingToken: null, tradingExpiresAtMs: null };
  }

  msUntilExpiry(): number | null {
    if (this.set.tradingExpiresAtMs === null) return null;
    return Math.max(0, this.set.tradingExpiresAtMs - this.clock.ms());
  }

  /** True when the token dies within the window — trigger a refresh. */
  expiresWithin(ms: number): boolean {
    const left = this.msUntilExpiry();
    return left !== null && left <= ms;
  }
}
