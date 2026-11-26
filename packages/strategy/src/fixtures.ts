import type { Candle } from '@tradeforger/core';

/*
 * Deterministic synthetic markets for strategy tests. Shaped like the real
 * NSE session: 5-min bars 09:15–15:25 IST on weekdays; daily bars stamped at
 * IST midnight (as Upstox stamps them). Regime-switching volatility and
 * volume so squeezes, breakouts and trend days actually occur.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const gauss = (r: () => number): number => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-12))) * Math.cos(2 * Math.PI * r());
const IST = 330 * 60_000;
const DAY = 86_400_000;
export const istMidnightOf = (date: string): number => Date.parse(`${date}T00:00:00Z`) - IST;

function weekdays(start: string, n: number): number[] {
  const out: number[] = [];
  for (let d = istMidnightOf(start); out.length < n; d += DAY) {
    const dow = new Date(d + IST).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

export interface Regime {
  readonly seed: number;
  readonly start: number;
  /** Per-bar drift (log return). */
  readonly drift: number;
  readonly vol: number;
  readonly volume?: number;
}

/**
 * Bars alternate between calm stretches (vol × 0.3, thin volume) and active
 * ones (vol × 1.5, volume × 2.5, drift × 2) every `cycle` bars — the texture
 * real intraday data has and a constant-vol random walk lacks.
 */
function series(stamps: number[], g: Regime, cycle: number): Candle[] {
  const r = mulberry32(g.seed);
  const out: Candle[] = [];
  let px = g.start;
  stamps.forEach((ts, i) => {
    const active = Math.floor(i / cycle) % 2 === 1;
    const vol = g.vol * (active ? 1.5 : 0.3);
    const drift = g.drift * (active ? 2 : 0.3);
    const open = px;
    const close = open * Math.exp(drift + vol * gauss(r));
    const high = Math.max(open, close) * (1 + Math.abs(vol * 0.5 * gauss(r)));
    const low = Math.min(open, close) * (1 - Math.abs(vol * 0.5 * gauss(r)));
    const base = g.volume ?? 10_000;
    const volume = Math.round(base * (active ? 2.5 : 0.6) * (0.6 + 0.8 * r()));
    const p2 = (x: number): number => Math.round(x * 100) / 100;
    out.push({ ts, open: p2(open), high: p2(high), low: p2(low), close: p2(close), volume });
    px = close;
  });
  return out;
}

export function intraday(start: string, days: number, g: Regime, cycle = 12): Candle[] {
  const stamps = weekdays(start, days).flatMap((d) => Array.from({ length: 75 }, (_, k) => d + (555 + 5 * k) * 60_000));
  return series(stamps, g, cycle);
}

export function daily(start: string, bars: number, g: Regime, cycle = 25): Candle[] {
  return series(weekdays(start, bars), g, cycle);
}

/** Close time of a bar: +5 min / +15 min intraday, 15:30 IST for daily. */
export const closeOf = (c: Candle, tf: '5m' | '15m' | '1d'): number =>
  tf === '5m' ? c.ts + 300_000 : tf === '15m' ? c.ts + 900_000 : Math.floor((c.ts + IST) / DAY) * DAY - IST + 930 * 60_000;
