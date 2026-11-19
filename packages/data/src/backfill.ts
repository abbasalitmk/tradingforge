import { MAX_SPAN_DAYS, HISTORY_FROM, type Unit, type UpstoxClient } from '@tradeforger/upstox';
import type { Candle, Result } from '@tradeforger/core';

export interface Chunk {
  readonly from: string; // YYYY-MM-DD
  readonly to: string;
}

const DAY_MS = 86_400_000;
const iso = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Split a date range into requests Upstox will actually honour.
 *
 * Exceeding the per-unit span returns an "invalid request" error rather than
 * truncating the result, so a naive single-call backfill of a year of 1-minute
 * candles fails outright instead of returning partial data. The planner also
 * clamps to the earliest date Upstox holds for that unit.
 *
 * Chunks are returned newest-first, so a partial backfill yields the most
 * recent (and most useful) data first.
 */
export function planChunks(unit: Unit, interval: number, from: string, to: string): Chunk[] {
  const maxSpan = MAX_SPAN_DAYS[unit](interval);
  const earliest = new Date(HISTORY_FROM[unit]).getTime();

  const start = Math.max(new Date(from).getTime(), earliest);
  const end = new Date(to).getTime();
  if (end < start) return [];

  const chunks: Chunk[] = [];
  let cursor = end;

  while (cursor >= start) {
    const chunkStart = Math.max(start, cursor - (maxSpan - 1) * DAY_MS);
    chunks.push({ from: iso(new Date(chunkStart)), to: iso(new Date(cursor)) });
    if (chunkStart === start) break;
    cursor = chunkStart - DAY_MS;
  }
  return chunks;
}

export interface BackfillProgress {
  readonly chunk: number;
  readonly total: number;
  readonly candles: number;
}

/**
 * Fetch a full range, chunked and deduplicated.
 *
 * Stops on the first hard failure rather than silently returning a gapped
 * series — a hole in the candle history produces wrong indicator values, which
 * is worse than no data at all because it looks like data.
 */
export async function backfill(
  client: UpstoxClient,
  instrumentKey: string,
  unit: Unit,
  interval: number,
  from: string,
  to: string,
  onProgress?: (p: BackfillProgress) => void,
): Promise<Result<Candle[], Error>> {
  const chunks = planChunks(unit, interval, from, to);
  const byTs = new Map<number, Candle>();

  for (const [i, chunk] of chunks.entries()) {
    const r = await client.historicalCandles(instrumentKey, unit, interval, chunk.to, chunk.from);
    if (!r.ok) {
      return { ok: false, error: new Error(
        `backfill failed at chunk ${i + 1}/${chunks.length} (${chunk.from}..${chunk.to}): ${r.error.message}`,
      ) };
    }
    for (const c of r.value) byTs.set(c.ts, c);
    onProgress?.({ chunk: i + 1, total: chunks.length, candles: byTs.size });
  }

  const candles = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { ok: true, value: candles };
}

/**
 * Cross-check a locally-built candle against the exchange's own.
 *
 * Live candles are aggregated from ticks, which can drop frames. Divergence
 * beyond a tolerance means our aggregation is wrong and the indicators built on
 * it are untrustworthy.
 */
export function candleDivergence(local: Candle, official: Candle): number {
  if (official.close === 0) return 0;
  return Math.abs(local.close - official.close) / official.close;
}

export const DIVERGENCE_TOLERANCE = 0.001; // 0.1%
