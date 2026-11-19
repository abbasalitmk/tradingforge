import type {
  Result, OrderRequest, OrderAck, Fill, Paise, Mode, Product, Side, PositionId,
} from '@tradeforger/core';

/**
 * A complete trade: entry plus its exchange-side OCO exits, as ONE order.
 *
 * Upstox GTT MULTIPLE requires an ENTRY leg — a GTT holding only TARGET and
 * STOPLOSS is rejected — so the bracket cannot be bolted on after a separate
 * entry fill. Sending entry and exits together also means there is no window
 * in which a filled position exists without a live stop.
 */
export interface BracketOrder {
  readonly positionId: PositionId;
  readonly instrumentKey: string;
  /** Direction of the ENTRY. The exit legs are the opposite side. */
  readonly side: Side;
  readonly quantity: number;
  readonly product: Product;
  /** IMMEDIATE enters at market now; ABOVE/BELOW wait for a breakout level. */
  readonly entryTrigger: 'IMMEDIATE' | 'ABOVE' | 'BELOW';
  readonly entryPrice: Paise;
  readonly targetPrice: Paise;
  readonly stopLossPrice: Paise;
  /** Server-side trailing stop. Upstox requires >= 10% of |LTP - SL trigger|. */
  readonly trailingGap?: Paise;
  /** -1 auto, 0 none, 1-25 percent. Caps slippage on the market exit leg. */
  readonly marketProtection?: number;
}

export interface BracketAck {
  readonly gttOrderId: string;
}

/** A market exit of an open position, outside its bracket (manual, EOD, time stop). */
export interface ExitRequest {
  readonly positionId: PositionId;
  readonly instrumentKey: string;
  /** Side of the EXIT order — opposite of the entry. */
  readonly side: Side;
  readonly quantity: number;
  readonly product: Product;
}

export type ExitLeg = 'TARGET' | 'STOPLOSS' | 'MANUAL';

/**
 * What the broker tells the engine happened. The engine's position state is
 * driven ONLY by these — never by the optimistic assumption that an
 * acknowledged order filled.
 */
export type BrokerEvent =
  | { readonly kind: 'ENTRY_FILLED'; readonly positionId: PositionId; readonly quantity: number; readonly avgPrice: Paise; readonly at: number }
  | { readonly kind: 'EXIT_FILLED'; readonly positionId: PositionId; readonly leg: ExitLeg; readonly quantity: number; readonly avgPrice: Paise; readonly at: number }
  /** The entry never happened (rejected, cancelled, expired). Nothing is held. */
  | { readonly kind: 'ENTRY_FAILED'; readonly positionId: PositionId; readonly reason: string; readonly at: number };

export type BrokerListener = (e: BrokerEvent) => void;

export class BrokerError extends Error {
  readonly kind: 'REJECTED' | 'BLOCKED' | 'TRANSPORT' | 'NOT_SUPPORTED';
  readonly detail: unknown;

  constructor(kind: BrokerError['kind'], message: string, detail?: unknown) {
    super(message);
    this.name = 'BrokerError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * The single interface through which the engine reaches a market.
 *
 * Paper, Sandbox and Live all implement this identically, which is what makes
 * the validation ladder meaningful: the strategy and risk code that runs in
 * paper is byte-for-byte the code that runs live, with only the port swapped.
 */
export interface BrokerPort {
  readonly mode: Mode;
  /** True only for a port that can move real money. */
  readonly isLive: boolean;

  placeOrder(req: OrderRequest): Promise<Result<OrderAck, BrokerError>>;
  cancelOrder(brokerOrderId: string): Promise<Result<void, BrokerError>>;

  /** Entry + native OCO exits in one GTT MULTIPLE. See docs/00-PLAN.md §0.1. */
  placeBracketOrder(order: BracketOrder): Promise<Result<BracketAck, BrokerError>>;
  /**
   * Cancel a bracket. Fails if a leg has already triggered — callers must NOT
   * then send their own exit, or the position is closed twice and reversed.
   */
  cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>>;
  /** Market-exit a position. The fill arrives later as an EXIT_FILLED event. */
  exitPosition(req: ExitRequest): Promise<Result<OrderAck, BrokerError>>;

  onEvent(listener: BrokerListener): void;
  /** Pull authoritative state and emit any events it implies. Idempotent. */
  sync(): Promise<void>;

  /** Authoritative state, never our optimistic view. */
  openOrders(): Promise<Result<readonly Fill[], BrokerError>>;
  exitAllPositions(): Promise<Result<number, BrokerError>>;
}
