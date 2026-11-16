import {
  type Result, ok, err, type OrderRequest, type OrderAck, type Fill,
  type Mode, type Clock, paiseToRupees, placesRealOrders,
} from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { BrokerError, type BrokerPort, type BracketSpec, type BracketAck } from './port.ts';

export interface UpstoxBrokerOptions {
  readonly client: UpstoxClient;
  readonly mode: Mode;
  readonly clock: Clock;
}

/**
 * Upstox Broker Port adapter.
 *
 * Implements BrokerPort against the real Upstox API.
 * Mode-gated: places real orders only when mode is LIVE and placesRealOrders(mode) is true.
 * For GTT brackets, constructs native Upstox GTT MULTIPLE payloads with exchange-side trailing SL.
 */
export class UpstoxBroker implements BrokerPort {
  readonly mode: Mode;
  readonly isLive: boolean;
  private readonly client: UpstoxClient;
  private readonly clock: Clock;

  constructor(opts: UpstoxBrokerOptions) {
    this.client = opts.client;
    this.mode = opts.mode;
    this.isLive = placesRealOrders(opts.mode);
    this.clock = opts.clock;
  }

  async placeOrder(req: OrderRequest): Promise<Result<OrderAck, BrokerError>> {
    if (this.mode === 'PAPER') {
      return err(new BrokerError('BLOCKED', 'Paper mode cannot place live Upstox orders'));
    }

    const payload = {
      quantity: req.quantity,
      product: req.product,
      validity: req.validity,
      price: req.orderType === 'MARKET' ? 0 : paiseToRupees(req.price),
      tag: req.tag,
      instrument_token: req.instrumentKey,
      order_type: req.orderType,
      transaction_type: req.side,
      disclosed_quantity: 0,
      trigger_price: req.orderType.includes('SL') ? paiseToRupees(req.triggerPrice) : 0,
      is_amo: false,
    };

    const res = await this.client.placeOrder(payload);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }

    const data = res.value as { data?: { order_id?: string } };
    const orderId = data?.data?.order_id ?? `ord-${this.clock.ms()}`;
    return ok({ brokerOrderId: orderId, acceptedAt: this.clock.ms() });
  }

  async cancelOrder(brokerOrderId: string): Promise<Result<void, BrokerError>> {
    const res = await this.client.cancelOrder(brokerOrderId);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    return ok(undefined);
  }

  /**
   * Places native GTT MULTIPLE OCO bracket on Upstox.
   */
  async placeBracket(spec: BracketSpec): Promise<Result<BracketAck, BrokerError>> {
    const targetRs = paiseToRupees(spec.targetPrice);
    const slRs = paiseToRupees(spec.stopLossPrice);
    const trailingRs = spec.trailingGap ? paiseToRupees(spec.trailingGap) : 0;

    const rules = [
      {
        strategy: 'TARGET',
        trigger_type: 'IMMEDIATE',
        trigger_price: targetRs,
      },
      {
        strategy: 'STOPLOSS',
        trigger_type: 'IMMEDIATE',
        trigger_price: slRs,
        ...(trailingRs > 0 ? { trailing_gap: trailingRs } : {}),
        market_protection: spec.marketProtection ?? -1,
      },
    ];

    const payload = {
      type: 'MULTIPLE',
      quantity: spec.quantity,
      product: spec.product,
      instrument_token: spec.instrumentKey,
      transaction_type: spec.exitSide,
      rules,
    };

    const res = await this.client.placeGtt(payload);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }

    const data = res.value as { data?: { gtt_order_id?: string } };
    const gttId = data?.data?.gtt_order_id ?? `gtt-${this.clock.ms()}`;
    return ok({ gttOrderId: gttId });
  }

  async cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>> {
    const res = await this.client.cancelGtt(gttOrderId);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    return ok(undefined);
  }

  async openOrders(): Promise<Result<readonly Fill[], BrokerError>> {
    const res = await this.client.orderBook();
    if (!res.ok) {
      return err(new BrokerError('TRANSPORT', res.error.message, res.error.body));
    }

    const data = res.value as { data?: Array<Record<string, unknown>> };
    const items = data?.data ?? [];
    const fills: Fill[] = items.map((o) => ({
      brokerOrderId: String(o['order_id'] ?? ''),
      instrumentKey: String(o['instrument_token'] ?? o['instrument_key'] ?? ''),
      side: (o['transaction_type'] as 'BUY' | 'SELL') ?? 'BUY',
      filledQuantity: Number(o['filled_quantity'] ?? 0),
      averagePrice: Math.round(Number(o['average_price'] ?? 0) * 100) as never,
      status: String(o['status'] ?? 'unknown'),
      at: o['order_timestamp'] ? new Date(String(o['order_timestamp'])).getTime() : this.clock.ms(),
    }));

    return ok(fills);
  }

  async exitAllPositions(): Promise<Result<number, BrokerError>> {
    const res = await this.client.exitAllPositions();
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    return ok(1);
  }
}
