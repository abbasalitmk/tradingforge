import type { Candle } from '@tradeforger/core';

/*
 * Deterministic synthetic markets for tests and demos. Seeded so a test that
 * passes once passes always; shaped like the real NSE session (5-min bars
 * 09:15–15:25 IST on weekdays; daily bars stamped at IST midnight, as Upstox
 * stamps them) so session logic is exercised exactly as in production.
 */

/** Mulberry32 — small, fast, deterministic. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
function gauss(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Epoch ms of IST midnight on a YYYY-MM-DD date. */
export const istMidnightOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) - IST_OFFSET_MS;

function* weekdays(startDate: string, count: number): Generator<number> {
  let day = istMidnightOf(startDate);
  let n = 0;
  while (n < count) {
    const dow = new Date(day + IST_OFFSET_MS).getUTCDay(); // 0 Sun … 6 Sat
    if (dow !== 0 && dow !== 6) {
      yield day;
      n++;
    }
    day += DAY_MS;
  }
}

export interface SeriesSpec {
  readonly seed: number;
  readonly startPrice: number;
  /** Mean log-return per bar (e.g. 0.0005 = +0.05%/bar trend). */
  readonly drift: number;
  /** Per-bar log-return standard deviation. */
  readonly vol: number;
  /** Mean volume per bar. */
  readonly volume?: number;
  /** Pull toward startPrice per bar (0 = random walk, 0.05 = mean-reverting). */
  readonly meanReversion?: number;
}

function bar(rand: () => number, ts: number, prev: number, s: SeriesSpec, anchor: number): Candle {
  const pull = s.meanReversion ? s.meanReversion * Math.log(anchor / prev) : 0;
  const ret = s.drift + pull + s.vol * gauss(rand);
  const close = prev * Math.exp(ret);
  const open = prev * Math.exp(s.vol * 0.2 * gauss(rand));
  const hi = Math.max(open, close) * (1 + Math.abs(s.vol * 0.6 * gauss(rand)));
  const lo = Math.min(open, close) * (1 - Math.abs(s.vol * 0.6 * gauss(rand)));
  const v = Math.max(1, Math.round((s.volume ?? 10_000) * (0.5 + rand())));
  const r2 = (x: number): number => Math.round(x * 100) / 100;
  return { ts, open: r2(open), high: r2(hi), low: r2(lo), close: r2(close), volume: v };
}

/** 5-minute session bars, 75 per weekday (09:15 … 15:25 IST). */
export function intradaySeries(startDate: string, days: number, s: SeriesSpec): Candle[] {
  const rand = mulberry32(s.seed);
  const out: Candle[] = [];
  let price = s.startPrice;
  for (const midnight of weekdays(startDate, days)) {
    for (let k = 0; k < 75; k++) {
      const c = bar(rand, midnight + (9 * 60 + 15 + k * 5) * 60_000, price, s, s.startPrice);
      out.push(c);
      price = c.close;
    }
  }
  return out;
}

/** Daily bars stamped at IST midnight, weekdays only. */
export function dailySeries(startDate: string, bars: number, s: SeriesSpec): Candle[] {
  const rand = mulberry32(s.seed);
  const out: Candle[] = [];
  let price = s.startPrice;
  for (const midnight of weekdays(startDate, bars)) {
    const c = bar(rand, midnight, price, s, s.startPrice);
    out.push(c);
    price = c.close;
  }
  return out;
}
