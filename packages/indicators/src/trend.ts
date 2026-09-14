import type { Candle } from '@tradeforger/core';
import type { Series } from './series.ts';

export function sma(data: readonly number[], period: number): Series {
  const out: Series = [];
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i]!;
    if (i >= period) sum -= data[i - period]!;
    out.push(i < period - 1 ? null : sum / period);
  }
  return out;
}

/**
 * EMA seeded from the SMA of the first `period` values — the standard
 * convention, and what TradingView uses. Seeding from the first price instead
 * produces values that converge but never quite match, which makes comparing
 * against a chart during debugging maddening.
 */
export function ema(data: readonly number[], period: number): Series {
  const out: Series = [];
  if (data.length < period) return data.map(() => null);

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += data[i]!;
  let value = seed / period;

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    if (i === period - 1) { out.push(value); continue; }
    value = (data[i]! - value) * k + value;
    out.push(value);
  }
  return out;
}

export interface MacdResult {
  readonly macd: Series;
  readonly signal: Series;
  readonly histogram: Series;
}

export function macd(
  data: readonly number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastE = ema(data, fast);
  const slowE = ema(data, slow);
  const line: Series = data.map((_, i) => {
    const f = fastE[i], s = slowE[i];
    return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
  });

  // The signal line is an EMA of the MACD line, which only exists once the slow
  // EMA has warmed up — so it must be computed over the non-null tail only.
  const firstValid = line.findIndex((v) => v !== null);
  const signal: Series = data.map(() => null);
  if (firstValid >= 0) {
    const tail = line.slice(firstValid).filter((v): v is number => v !== null);
    const sig = ema(tail, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i] ?? null;
  }

  const histogram: Series = line.map((m, i) => {
    const s = signal[i];
    return m !== null && s !== null && s !== undefined ? m - s : null;
  });

  return { macd: line, signal, histogram };
}

/** True Range — the basis of ATR, Supertrend and every ATR-scaled stop. */
export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1]!;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  });
}

/** Wilder-smoothed ATR, the convention every charting package uses. */
export function atr(candles: readonly Candle[], period = 14): Series {
  const tr = trueRange(candles);
  const out: Series = [];
  let value = 0;

  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) { value += tr[i]!; out.push(null); continue; }
    if (i === period - 1) {
      value = (value + tr[i]!) / period;
      out.push(value);
      continue;
    }
    value = (value * (period - 1) + tr[i]!) / period;
    out.push(value);
  }
  return out;
}

export interface SupertrendResult {
  readonly value: Series;
  /** +1 uptrend (price above the line), -1 downtrend. */
  readonly direction: (1 | -1 | null)[];
}

/**
 * Supertrend.
 *
 * The band-carry rules are the subtle part: a final band only moves in the
 * favourable direction unless price closes through it, which is what stops the
 * indicator whipsawing on every bar.
 */
export function supertrend(
  candles: readonly Candle[],
  period = 10,
  multiplier = 3,
): SupertrendResult {
  const a = atr(candles, period);
  const value: Series = [];
  const direction: (1 | -1 | null)[] = [];

  let finalUpper = 0;
  let finalLower = 0;
  let dir: 1 | -1 = 1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const av = a[i];
    if (av === null || av === undefined) {
      value.push(null); direction.push(null);
      continue;
    }

    const hl2 = (c.high + c.low) / 2;
    const upper = hl2 + multiplier * av;
    const lower = hl2 - multiplier * av;
    const prev = candles[i - 1];

    if (prev === undefined || value[i - 1] === null || value[i - 1] === undefined) {
      finalUpper = upper;
      finalLower = lower;
      dir = c.close > hl2 ? 1 : -1;
    } else {
      finalUpper = upper < finalUpper || prev.close > finalUpper ? upper : finalUpper;
      finalLower = lower > finalLower || prev.close < finalLower ? lower : finalLower;

      if (dir === 1 && c.close < finalLower) dir = -1;
      else if (dir === -1 && c.close > finalUpper) dir = 1;
    }

    value.push(dir === 1 ? finalLower : finalUpper);
    direction.push(dir);
  }

  return { value, direction };
}

export interface AdxResult {
  readonly adx: Series;
  readonly plusDi: Series;
  readonly minusDi: Series;
}

/** ADX — trend strength regardless of direction. Above 25 is a real trend. */
export function adx(candles: readonly Candle[], period = 14): AdxResult {
  const n = candles.length;
  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  const tr = trueRange(candles);

  for (let i = 1; i < n; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    const up = c.high - p.high;
    const down = p.low - c.low;
    plusDm.push(up > down && up > 0 ? up : 0);
    minusDm.push(down > up && down > 0 ? down : 0);
  }

  const smooth = (src: readonly number[]): Series => {
    const out: Series = [];
    let acc = 0;
    for (let i = 0; i < src.length; i++) {
      if (i < period) { acc += src[i]!; out.push(i === period - 1 ? acc : null); continue; }
      acc = acc - acc / period + src[i]!;
      out.push(acc);
    }
    return out;
  };

  const trS = smooth(tr), pS = smooth(plusDm), mS = smooth(minusDm);
  const plusDi: Series = [], minusDi: Series = [], dx: Series = [];

  for (let i = 0; i < n; i++) {
    const t = trS[i], p = pS[i], m = mS[i];
    if (!t || p === null || p === undefined || m === null || m === undefined) {
      plusDi.push(null); minusDi.push(null); dx.push(null);
      continue;
    }
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    plusDi.push(pdi); minusDi.push(mdi);
    const sum = pdi + mdi;
    dx.push(sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100);
  }

  const adxOut: Series = new Array(n).fill(null);
  const valid = dx.map((v, i) => ({ v, i })).filter((x) => x.v !== null);
  if (valid.length >= period) {
    let acc = 0;
    for (let k = 0; k < period; k++) acc += valid[k]!.v as number;
    let value = acc / period;
    adxOut[valid[period - 1]!.i] = value;
    for (let k = period; k < valid.length; k++) {
      value = (value * (period - 1) + (valid[k]!.v as number)) / period;
      adxOut[valid[k]!.i] = value;
    }
  }

  return { adx: adxOut, plusDi, minusDi };
}
