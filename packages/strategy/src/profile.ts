import type { Candle, Signal, TradingStyle, Clock } from '@tradeforger/core';

export interface StrategyContext {
  readonly instrumentKey: string;
  readonly symbol: string;
  /** Primary timeframe candles, oldest first. */
  readonly candles: readonly Candle[];
  /** Higher-timeframe candles for trend confirmation. */
  readonly higherTf: readonly Candle[];
  readonly clock: Clock;
}

/**
 * A trading profile.
 *
 * Profiles are pure: same candles in, same signal out. That is what makes the
 * replay harness a genuine regression suite — a strategy change that alters a
 * historical decision shows up as a diff, not as a vague feeling that
 * performance moved.
 */
export interface StrategyProfile {
  readonly style: TradingStyle;
  readonly name: string;
  /** Minimum bars required before the profile will emit anything. */
  readonly warmupBars: number;
  evaluate(ctx: StrategyContext): Signal | null;
}

export interface Confluence {
  readonly name: string;
  readonly passed: boolean;
  readonly weight: number;
  readonly detail: string;
}

/**
 * Score a set of weighted checks into a 0-100 confidence.
 *
 * Confidence is the fraction of achievable weight that actually fired, not a
 * hand-tuned magic number. The threshold at which a signal becomes tradeable
 * lives in the strategy, and is re-derived from backtests rather than guessed.
 */
export function scoreConfluence(checks: readonly Confluence[]): number {
  const total = checks.reduce((a, c) => a + c.weight, 0);
  if (total === 0) return 0;
  const earned = checks.filter((c) => c.passed).reduce((a, c) => a + c.weight, 0);
  return Math.round((earned / total) * 100);
}

export const passedNames = (checks: readonly Confluence[]): string[] =>
  checks.filter((c) => c.passed).map((c) => c.detail);
