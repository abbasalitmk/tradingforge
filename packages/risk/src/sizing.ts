import { type Paise, type SizingMode, pctOf, paise } from '@tradeforger/core';
import type { Limits } from '@tradeforger/safety';

export interface SizingInput {
  readonly mode: SizingMode;
  readonly entry: Paise;
  readonly stopLoss: Paise;
  /** FIXED_QTY only. */
  readonly fixedQty?: number | undefined;
  /** FIXED_BUDGET only — the most the user will spend on this trade. */
  readonly budget?: Paise | undefined;
  /** RISK_BASED only — percent of capital risked if the stop is hit. */
  readonly riskPct?: number | undefined;
  readonly capital: Paise;
  readonly availableMargin: Paise;
  readonly lotSize: number;
  /** Liquidity cap input: 20-day average daily volume in shares. */
  readonly avgDailyVolume: number;
  /** Capital already committed to open positions. */
  readonly deployedCapital: Paise;
}

export type RejectReason =
  | 'QTY_BELOW_ONE'
  | 'INVALID_STOP'
  | 'BELOW_MIN_TICKET'
  | 'NO_MARGIN'
  | 'DEPLOYED_CAP_REACHED'
  | 'MISSING_MODE_INPUT';

/** The complete, fixed set of constraints that can bind a position size. */
export interface Caps {
  readonly mode: number;
  readonly maxSpendPerTrade: number;
  readonly deployedCapital: number;
  readonly liquidity: number;
  readonly margin: number;
}
export type CapName = keyof Caps;

export interface SizingResult {
  readonly quantity: number;
  readonly costPaise: Paise;
  /** Which constraint actually determined the size — the most useful field
   *  when asking "why did it only buy 3 shares?" */
  readonly boundBy: CapName;
  readonly caps: Caps;
}

export type Sizing =
  | { ok: true; result: SizingResult }
  | { ok: false; reason: RejectReason; detail: string };

/**
 * Round-trip costs on a small NSE equity trade run roughly ₹40-60 once
 * brokerage, STT, exchange charges, GST and stamp duty are counted. A ticket
 * where those costs exceed ~1.5% of the target gain has no edge left to
 * capture, whatever the strategy thinks.
 */
const MIN_TICKET_PAISE = 200_000 as Paise; // ₹2,000

/**
 * Decide position size.
 *
 * Three user-selectable modes produce a candidate quantity; every candidate is
 * then clamped by the same hard caps, and the SMALLEST wins. Mode choice can
 * only ever make a position smaller than the caps allow, never larger — which
 * is what makes FIXED_QTY safe to offer at all. A fixed 25 shares is ₹2,500 on
 * one stock and ₹75,000 on another, so the rupee ceilings do the real work.
 */
export function size(input: SizingInput, limits: Limits): Sizing {
  const {
    mode, entry, stopLoss, capital, availableMargin,
    lotSize, avgDailyVolume, deployedCapital,
  } = input;

  if (entry <= 0) return { ok: false, reason: 'INVALID_STOP', detail: 'entry must be positive' };

  const riskPerShare = Math.abs(entry - stopLoss);
  if (riskPerShare <= 0) {
    return { ok: false, reason: 'INVALID_STOP', detail: 'stop-loss equals entry — risk per share is zero' };
  }

  // ── candidate quantity from the selected mode ───────────────────────────
  let candidate: number;
  switch (mode) {
    case 'FIXED_QTY': {
      if (input.fixedQty === undefined) {
        return { ok: false, reason: 'MISSING_MODE_INPUT', detail: 'fixedQty required for FIXED_QTY' };
      }
      candidate = Math.floor(input.fixedQty);
      break;
    }
    case 'FIXED_BUDGET': {
      if (input.budget === undefined) {
        return { ok: false, reason: 'MISSING_MODE_INPUT', detail: 'budget required for FIXED_BUDGET' };
      }
      candidate = Math.floor(input.budget / entry);
      break;
    }
    case 'RISK_BASED': {
      if (input.riskPct === undefined) {
        return { ok: false, reason: 'MISSING_MODE_INPUT', detail: 'riskPct required for RISK_BASED' };
      }
      candidate = Math.floor(pctOf(capital, input.riskPct) / riskPerShare);
      break;
    }
  }

  // ── hard caps, always applied regardless of mode ────────────────────────
  const remainingDeployable = Math.max(0, limits.maxDeployedCapitalPaise - deployedCapital);
  if (remainingDeployable < entry) {
    return {
      ok: false,
      reason: 'DEPLOYED_CAP_REACHED',
      detail: `deployed ${deployedCapital} of ${limits.maxDeployedCapitalPaise} paise; no room for one share`,
    };
  }

  const caps: Caps = {
    mode: candidate,
    maxSpendPerTrade: Math.floor(limits.maxSpendPerTradePaise / entry),
    deployedCapital: Math.floor(remainingDeployable / entry),
    // Never take more than 1% of a day's volume — our own liquidity guard, not
    // Upstox's. Larger and the exit becomes the problem.
    liquidity: Math.floor(avgDailyVolume * 0.01),
    margin: Math.floor(availableMargin / entry),
  };

  let boundBy: CapName = 'mode';
  let quantity = candidate;
  for (const name of Object.keys(caps) as CapName[]) {
    const cap = caps[name];
    if (cap < quantity) {
      quantity = cap;
      boundBy = name;
    }
  }

  // Round down to a whole lot; equities are lot size 1, F&O is not.
  if (lotSize > 1) {
    const lots = Math.floor(quantity / lotSize);
    quantity = lots * lotSize;
    if (lots === 0) {
      return { ok: false, reason: 'QTY_BELOW_ONE', detail: `below one lot of ${lotSize}` };
    }
  }

  if (quantity < 1) {
    return { ok: false, reason: 'QTY_BELOW_ONE', detail: `bound by ${boundBy}` };
  }

  const cost = paise(quantity * entry);
  if (availableMargin < cost) {
    return { ok: false, reason: 'NO_MARGIN', detail: `need ${cost}, have ${availableMargin} paise` };
  }
  if (cost < MIN_TICKET_PAISE) {
    return {
      ok: false,
      reason: 'BELOW_MIN_TICKET',
      detail: `${cost} paise below minimum viable ticket ${MIN_TICKET_PAISE} — charges would exceed the edge`,
    };
  }

  return { ok: true, result: { quantity, costPaise: cost, boundBy, caps } };
}
