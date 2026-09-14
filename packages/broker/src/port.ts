import type { Result, OrderRequest, OrderAck, Fill, Paise, Mode } from '@tradeforger/core';

export interface BracketSpec {
  readonly instrumentKey: string;
  readonly quantity: number;
  readonly product: 'I' | 'D' | 'MTF';
  /** Direction of the EXIT legs — opposite of the entry side. */
  readonly exitSide: 'BUY' | 'SELL';
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

  /** Native OCO bracket — GTT MULTIPLE. See docs/00-PLAN.md §0.1. */
  placeBracket(spec: BracketSpec): Promise<Result<BracketAck, BrokerError>>;
  cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>>;

  /** Authoritative state, never our optimistic view. */
  openOrders(): Promise<Result<readonly Fill[], BrokerError>>;
  exitAllPositions(): Promise<Result<number, BrokerError>>;
}
