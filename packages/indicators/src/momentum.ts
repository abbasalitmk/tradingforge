import type { Candle } from '@tradeforger/core';
import type { Series } from './series.ts';

/**
 * RSI with Wilder smoothing.
 *
 * The stockwatch version recomputed a simple average of gains/losses on every
 * bar, which drifts from every charting package after ~30 bars. This uses the
 * recursive Wilder formulation, so values match TradingView.
 */
export function rsi(data: readonly number[], period = 14): Series {
  const out: Series = new Array(data.length).fill(null);
  if (data.length <= period) return out;

  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = data[i]! - data[i - 1]!;
    if (diff >= 0) gain += diff; else loss -= diff;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i]! - data[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface BollingerResult {
  readonly upper: Series;
  readonly middle: Series;
  readonly lower: Series;
  /** Band width as a fraction of the middle band — the squeeze signal. */
  readonly bandwidth: Series;
}

export function bollinger(data: readonly number[], period = 20, stdDev = 2): BollingerResult {
  const upper: Series = [], middle: Series = [], lower: Series = [], bandwidth: Series = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      upper.push(null); middle.push(null); lower.push(null); bandwidth.push(null);
      continue;
    }
    const window = data.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);

    const u = mean + stdDev * sd;
    const l = mean - stdDev * sd;
    upper.push(u); middle.push(mean); lower.push(l);
    bandwidth.push(mean === 0 ? null : (u - l) / mean);
  }
  return { upper, middle, lower, bandwidth };
}

export interface StochasticResult {
  readonly k: Series;
  readonly d: Series;
}

export function stochastic(
  candles: readonly Candle[],
  period = 14,
  smoothK = 3,
  smoothD = 3,
): StochasticResult {
  const rawK: Series = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) { rawK.push(null); continue; }
    const window = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...window.map((c) => c.high));
    const lo = Math.min(...window.map((c) => c.low));
    rawK.push(hi === lo ? 50 : ((candles[i]!.close - lo) / (hi - lo)) * 100);
  }

  const smoothSeries = (s: Series, n: number): Series =>
    s.map((_, i) => {
      if (i < n - 1) return null;
      const w = s.slice(i - n + 1, i + 1);
      if (w.some((v) => v === null || v === undefined)) return null;
      return (w as number[]).reduce((a, b) => a + b, 0) / n;
    });

  const k = smoothSeries(rawK, smoothK);
  return { k, d: smoothSeries(k, smoothD) };
}

/**
 * VWAP, reset daily.
 *
 * Intraday VWAP that does not reset at the session boundary is meaningless —
 * it slowly becomes a long-run average and stops being the intraday reference
 * institutions actually trade around.
 */
export function vwap(candles: readonly Candle[]): Series {
  const out: Series = [];
  let cumPV = 0, cumVol = 0;
  let currentDay = '';

  for (const c of candles) {
    const day = new Date(c.ts).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      cumPV = 0;
      cumVol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    out.push(cumVol === 0 ? null : cumPV / cumVol);
  }
  return out;
}

/** Relative volume vs the trailing average — the spike detector. */
export function relativeVolume(candles: readonly Candle[], period = 20): Series {
  const out: Series = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period) { out.push(null); continue; }
    const window = candles.slice(i - period, i);
    const avg = window.reduce((a, c) => a + c.volume, 0) / period;
    out.push(avg === 0 ? null : candles[i]!.volume / avg);
  }
  return out;
}
