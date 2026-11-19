import type { Candle, Tick } from '@tradeforger/core';

/**
 * Builds candles from a tick stream.
 *
 * Needed because the REST candle endpoints lag the live market — an intraday
 * strategy acting on 5-minute candles cannot wait for Upstox to publish the bar
 * that just closed. Bars built here are cross-checked against the official
 * candle on close (see backfill.ts) and a mismatch raises an alert rather than
 * being silently accepted.
 */
export class CandleAggregator {
  private readonly intervalMs: number;
  private readonly open = new Map<string, Candle & { ts: number }>();
  private readonly lastCumVolume = new Map<string, number>();

  constructor(intervalMinutes: number) {
    this.intervalMs = intervalMinutes * 60_000;
  }

  /** Bucket start for a timestamp, aligned to the interval. */
  private bucket(ts: number): number {
    return Math.floor(ts / this.intervalMs) * this.intervalMs;
  }

  /**
   * Volume traded since the previous tick. The feed's cumulative day volume is
   * authoritative; summing last-traded-quantity undercounts whenever several
   * trades are coalesced into one frame, which skews relative volume.
   */
  private volumeDelta(tick: Tick): number {
    if (tick.volume === undefined) return tick.ltq ?? 0;
    const prev = this.lastCumVolume.get(tick.instrumentKey);
    this.lastCumVolume.set(tick.instrumentKey, tick.volume);
    // First sight of an instrument, or a day reset: nothing attributable yet.
    if (prev === undefined || tick.volume < prev) return tick.ltq ?? 0;
    return tick.volume - prev;
  }

  /** Returns a completed candle when the tick rolls into a new bucket. */
  push(tick: Tick): Candle | null {
    const b = this.bucket(tick.ts);
    const vol = this.volumeDelta(tick);
    const current = this.open.get(tick.instrumentKey);

    if (!current) {
      this.open.set(tick.instrumentKey, {
        ts: b, open: tick.ltp, high: tick.ltp, low: tick.ltp,
        close: tick.ltp, volume: vol,
      });
      return null;
    }

    if (b > current.ts) {
      this.open.set(tick.instrumentKey, {
        ts: b, open: tick.ltp, high: tick.ltp, low: tick.ltp,
        close: tick.ltp, volume: vol,
      });
      return current;
    }

    // Same bucket — extend it. A tick older than the current bucket is a
    // late/out-of-order frame and is dropped rather than corrupting the bar.
    if (b < current.ts) return null;

    this.open.set(tick.instrumentKey, {
      ts: current.ts,
      open: current.open,
      high: Math.max(current.high, tick.ltp),
      low: Math.min(current.low, tick.ltp),
      close: tick.ltp,
      volume: current.volume + vol,
    });
    return null;
  }

  /** The in-progress bar, for indicators that want the live partial candle. */
  peek(instrumentKey: string): Candle | null {
    return this.open.get(instrumentKey) ?? null;
  }

  /** Force-close all open bars, e.g. at session end. */
  flush(): Candle[] {
    const out = [...this.open.values()];
    this.open.clear();
    return out;
  }
}
