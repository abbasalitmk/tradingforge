import type { Paise } from '@tradeforger/core';

/**
 * Every hard limit in one place, so an audit of "what can this system do to my
 * money" is a single file read rather than a code hunt.
 *
 * These are CEILINGS, not strategy parameters. A strategy may choose to be more
 * conservative; it can never widen anything here.
 */
export interface Limits {
  /** Absolute rupee ceiling on a single trade, regardless of sizing mode. */
  readonly maxSpendPerTradePaise: Paise;
  /** Absolute rupee ceiling on total capital deployed across open positions. */
  readonly maxDeployedCapitalPaise: Paise;
  /** Daily loss as % of starting capital. Trips the day. */
  readonly dailyLossPct: number;
  /** Single-trade loss as % of starting capital. Force-exits that position. */
  readonly perTradeLossPct: number;
  readonly maxConcurrentPositions: number;
  readonly maxConsecutiveLosses: number;
  readonly maxOrdersPerDay: number;
  /** An autonomous system placing more than this per minute is malfunctioning. */
  readonly maxOrdersPerMinute: number;
  readonly maxRejectsIn5Min: number;
  /** No tick for this long during market hours halts new entries. */
  readonly feedStalenessMs: number;
  /** Margin utilisation above this rejects new entries. */
  readonly maxMarginUtilisationPct: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxSpendPerTradePaise: 1_000_000 as Paise,      // ₹10,000
  maxDeployedCapitalPaise: 5_000_000 as Paise,    // ₹50,000
  dailyLossPct: 2,
  perTradeLossPct: 1,
  maxConcurrentPositions: 3,
  maxConsecutiveLosses: 3,
  maxOrdersPerDay: 40,
  maxOrdersPerMinute: 6,
  maxRejectsIn5Min: 3,
  feedStalenessMs: 10_000,
  maxMarginUtilisationPct: 80,
};
