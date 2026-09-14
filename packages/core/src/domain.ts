import { z } from 'zod';
import type { Paise } from './money.ts';
import type { PositionId, SignalId } from './ids.ts';

/** Execution mode ladder. Downgrade is always allowed; upgrade never automatic. */
export const Mode = z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']);
export type Mode = z.infer<typeof Mode>;

/** Ordered by danger, so comparisons like `rank(mode) >= rank('LIVE_ARMED')` work. */
export const MODE_RANK: Record<Mode, number> = {
  PAPER: 0,
  SANDBOX: 1,
  LIVE_ARMED: 2,
  LIVE: 3,
};

/** Only LIVE may reach the real exchange with real money. */
export const placesRealOrders = (m: Mode): boolean => m === 'LIVE';

export const Side = z.enum(['BUY', 'SELL']);
export type Side = z.infer<typeof Side>;

export const Product = z.enum(['I', 'D', 'MTF']);
export type Product = z.infer<typeof Product>;

export const OrderType = z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']);
export type OrderType = z.infer<typeof OrderType>;

export const Validity = z.enum(['DAY', 'IOC']);
export type Validity = z.infer<typeof Validity>;

export const TradingStyle = z.enum(['SCALP', 'INTRADAY', 'SWING']);
export type TradingStyle = z.infer<typeof TradingStyle>;

/** User-selectable position sizing. See docs/00-PLAN.md §6.2. */
export const SizingMode = z.enum(['FIXED_QTY', 'FIXED_BUDGET', 'RISK_BASED']);
export type SizingMode = z.infer<typeof SizingMode>;

/**
 * Execution state machine. Every transition is persisted BEFORE the side
 * effect that causes it, so a crash mid-order is recoverable by replaying the
 * journal against the broker's order book.
 */
export const PositionState = z.enum([
  'CANDIDATE',
  'AI_REVIEWED',
  'RISK_APPROVED',
  'ENTRY_SENT',
  'ENTRY_ACKED',
  'ENTRY_FILLED',
  'BRACKET_ARMED',
  'MANAGING',
  'EXIT_TRIGGERED',
  'EXIT_FILLED',
  'CLOSED',
  'REJECTED',
  'CANCELLED',
  /** Position open with no live bracket. The most dangerous state in the
   *  system: it halts the engine and never auto-resolves. */
  'ORPHANED',
]);
export type PositionState = z.infer<typeof PositionState>;

const TERMINAL: ReadonlySet<PositionState> = new Set(['CLOSED', 'REJECTED', 'CANCELLED']);
export const isTerminal = (s: PositionState): boolean => TERMINAL.has(s);

/** Legal transitions. Anything absent here is a bug, not an edge case. */
export const TRANSITIONS: Readonly<Record<PositionState, readonly PositionState[]>> = {
  CANDIDATE: ['AI_REVIEWED', 'REJECTED'],
  AI_REVIEWED: ['RISK_APPROVED', 'REJECTED'],
  RISK_APPROVED: ['ENTRY_SENT', 'REJECTED'],
  ENTRY_SENT: ['ENTRY_ACKED', 'REJECTED', 'CANCELLED'],
  ENTRY_ACKED: ['ENTRY_FILLED', 'CANCELLED', 'REJECTED'],
  ENTRY_FILLED: ['BRACKET_ARMED', 'ORPHANED'],
  BRACKET_ARMED: ['MANAGING', 'ORPHANED'],
  MANAGING: ['EXIT_TRIGGERED', 'ORPHANED'],
  EXIT_TRIGGERED: ['EXIT_FILLED', 'ORPHANED'],
  EXIT_FILLED: ['CLOSED'],
  CLOSED: [],
  REJECTED: [],
  CANCELLED: [],
  ORPHANED: ['MANAGING', 'EXIT_TRIGGERED', 'CLOSED'], // manual resolution only
};

export function canTransition(from: PositionState, to: PositionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface Instrument {
  readonly instrumentKey: string; // "NSE_EQ|INE002A01018"
  readonly tradingSymbol: string;
  readonly name: string;
  readonly exchange: string;
  readonly segment: string;
  readonly isin: string | null;
  readonly lotSize: number;
  readonly tickSize: number;
}

export interface Candle {
  readonly ts: number; // epoch ms
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly oi?: number;
}

export interface Tick {
  readonly instrumentKey: string;
  readonly ltp: number;
  readonly ltq?: number;
  readonly volume?: number;
  readonly close?: number;
  readonly ts: number;
}

/** A deterministic candidate produced by the indicator engine, pre-AI, pre-risk. */
export interface Signal {
  readonly id: SignalId;
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly style: TradingStyle;
  readonly side: Side;
  readonly entry: Paise;
  readonly stopLoss: Paise;
  readonly target: Paise;
  readonly atr: number;
  readonly confidence: number; // 0-100, from the deterministic engine
  readonly reasons: readonly string[];
  readonly indicators: Readonly<Record<string, number>>;
  readonly generatedAt: number;
}

export interface OrderRequest {
  readonly positionId: PositionId;
  readonly instrumentKey: string;
  readonly side: Side;
  readonly quantity: number;
  readonly orderType: OrderType;
  readonly product: Product;
  readonly validity: Validity;
  readonly price: Paise;
  readonly triggerPrice: Paise;
  readonly tag: string;
}

export interface OrderAck {
  readonly brokerOrderId: string;
  readonly acceptedAt: number;
}

export interface Fill {
  readonly brokerOrderId: string;
  readonly instrumentKey: string;
  readonly side: Side;
  readonly filledQuantity: number;
  readonly averagePrice: Paise;
  readonly status: string;
  readonly at: number;
}

/** Risk distance in rupees-per-share; the denominator of risk-based sizing. */
export const riskPerShare = (entry: Paise, stop: Paise): Paise =>
  Math.abs(entry - stop) as Paise;
