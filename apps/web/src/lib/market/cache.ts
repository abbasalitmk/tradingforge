/**
 * Per-instance TTL memo. A warm serverless instance serves repeat polls from
 * memory instead of re-spending the Upstox rate limit; concurrent callers for
 * the same key share one in-flight request. Failures are never cached.
 */
export class TtlCache {
  private readonly entries = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.entries.set(key, { at: this.now(), value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
