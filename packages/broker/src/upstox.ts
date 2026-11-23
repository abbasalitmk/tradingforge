import {
  type Result, ok, err, type OrderRequest, type OrderAck, type Fill,
  type Mode, type Clock, type Paise, type PositionId, type Side,
  paiseToRupees, rupeesToPaise, placesRealOrders,
} from '@tradeforger/core';
import type { UpstoxClient, schemas } from '@tradeforger/upstox';
import {
  BrokerError, type BrokerPort, type BracketOrder, type BracketAck,
  type BrokerEvent, type BrokerListener, type ExitRequest, type ExitLeg,
} from './port.ts';

/**
 * Market price protection on every market order we send: -1 is Upstox's
 * automatic band. The exchange rejects API market orders without protection
 * (0); a fixed percentage would be one number for every instrument's volatility.
 */
export const MARKET_PROTECTION = -1;

export interface UpstoxBrokerOptions {
  readonly client: UpstoxClient;
  readonly clock: Clock;
  /**
   * The EFFECTIVE mode, read at the moment of every order write. Passing a
   * function rather than a value is the point: an arm that expires at 15:30
   * must stop the very next order, not the next engine restart.
   */
  readonly modeGate: () => Mode;
  /** Records the exact payload an order write would have sent while not LIVE. */
  readonly onDryRun?: (kind: string, payload: unknown) => void;
}

interface Tracked {
  readonly positionId: PositionId;
  readonly gttOrderId: string;
  readonly instrumentKey: string;
  readonly side: Side;
  readonly product: string;
  entryDone: boolean;
  exitDone: boolean;
  /** Our own market exit, outside the bracket. */
  manualExitOrderId: string | null;
  /** Set by exitAllPositions: any new opposite-side fill on the instrument closes us. */
  flattenFrom: ReadonlySet<string> | null;
}

const FAILED_RULE = new Set(['FAILED', 'CANCELLED', 'EXPIRED', 'REJECTED']);
const lc = (s: string | undefined | null): string => (s ?? '').toLowerCase();

/**
 * Upstox Broker Port adapter.
 *
 * Three properties matter more than anything else here:
 *
 *  1. Broker ids are read from the response or the call FAILS. Inventing an id
 *     on a missing field (the previous behaviour) produced orders the engine
 *     could neither track nor cancel.
 *  2. Fills come from the broker's own order book and GTT state, never from
 *     the assumption that an acknowledged order filled.
 *  3. Every order write consults the effective mode at call time. LIVE_ARMED
 *     logs the payload and sends nothing.
 */
export class UpstoxBroker implements BrokerPort {
  private readonly client: UpstoxClient;
  private readonly clock: Clock;
  private readonly modeGate: () => Mode;
  private readonly onDryRun: ((kind: string, payload: unknown) => void) | undefined;
  private readonly listeners: BrokerListener[] = [];
  private readonly tracked = new Map<string, Tracked>();
  private syncing: Promise<void> | null = null;

  constructor(opts: UpstoxBrokerOptions) {
    this.client = opts.client;
    this.clock = opts.clock;
    this.modeGate = opts.modeGate;
    this.onDryRun = opts.onDryRun;
  }

  get mode(): Mode {
    return this.modeGate();
  }

  get isLive(): boolean {
    return placesRealOrders(this.modeGate());
  }

  onEvent(listener: BrokerListener): void {
    this.listeners.push(listener);
  }

  private emit(e: BrokerEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Refuse an order write unless effectively LIVE right now. */
  private gate(kind: string, payload: unknown): BrokerError | null {
    const mode = this.modeGate();
    if (placesRealOrders(mode)) return null;
    this.onDryRun?.(kind, payload);
    return new BrokerError('BLOCKED', `mode ${mode} — ${kind} not sent (dry run)`);
  }

  async placeOrder(req: OrderRequest): Promise<Result<OrderAck, BrokerError>> {
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
      slice: false,
      ...(req.orderType === 'MARKET' || req.orderType === 'SL-M' ? { market_protection: MARKET_PROTECTION } : {}),
    };
    const blocked = this.gate('order', payload);
    if (blocked) return err(blocked);
    return this.sendOrder(payload);
  }

  private async sendOrder(payload: Record<string, unknown>): Promise<Result<OrderAck, BrokerError>> {
    const res = await this.client.placeOrder(payload);
    if (!res.ok) {
      return err(new BrokerError(
        res.error.kind === 'TIMEOUT' || res.error.kind === 'NETWORK' || res.error.kind === 'SERVER_ERROR'
          ? 'TRANSPORT' : 'REJECTED',
        res.error.message, res.error.body,
      ));
    }
    const ids = (res.value as { data?: { order_ids?: string[]; order_id?: string } })?.data;
    const orderId = ids?.order_ids?.[0] ?? ids?.order_id;
    if (!orderId) {
      return err(new BrokerError('TRANSPORT', 'order accepted but no order id returned — reconcile against the order book', res.value));
    }
    return ok({ brokerOrderId: orderId, acceptedAt: this.clock.ms() });
  }

  async cancelOrder(brokerOrderId: string): Promise<Result<void, BrokerError>> {
    const res = await this.client.cancelOrder(brokerOrderId);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    return ok(undefined);
  }

  /** Entry + target + stop as one GTT MULTIPLE. The ENTRY leg is mandatory. */
  async placeBracketOrder(o: BracketOrder): Promise<Result<BracketAck, BrokerError>> {
    // Upstox strictly rejects GTT legs not rounded to the 0.05 NSE tick size.
    const toTick = (paiseVal: number): number => {
      const roundedPaise = Math.round(paiseVal / 5) * 5;
      return paiseToRupees(roundedPaise as Paise);
    };

    const protection = o.marketProtection ?? MARKET_PROTECTION;
    const payload = {
      type: 'MULTIPLE',
      quantity: o.quantity,
      product: o.product,
      instrument_token: o.instrumentKey,
      transaction_type: o.side,
      rules: [
        // Every leg goes out as a market order with price protection (MPP):
        // the exchange refuses unprotected API market orders.
        { strategy: 'ENTRY', trigger_type: o.entryTrigger, trigger_price: toTick(o.entryPrice), market_protection: protection },
        { strategy: 'TARGET', trigger_type: 'IMMEDIATE', trigger_price: toTick(o.targetPrice), market_protection: protection },
        {
          strategy: 'STOPLOSS',
          trigger_type: 'IMMEDIATE',
          trigger_price: toTick(o.stopLossPrice),
          ...(o.trailingGap && o.trailingGap > 0 ? { trailing_gap: toTick(o.trailingGap) } : {}),
          market_protection: protection,
        },
      ],
    };
    const blocked = this.gate('gtt', payload);
    if (blocked) return err(blocked);

    const res = await this.client.placeGtt(payload);
    if (!res.ok) {
      return err(new BrokerError(
        res.error.kind === 'TIMEOUT' || res.error.kind === 'NETWORK' || res.error.kind === 'SERVER_ERROR'
          ? 'TRANSPORT' : 'REJECTED',
        res.error.message, res.error.body,
      ));
    }
    const gttId = (res.value as { data?: { gtt_order_ids?: string[] } })?.data?.gtt_order_ids?.[0];
    if (!gttId) {
      return err(new BrokerError('TRANSPORT', 'GTT accepted but no gtt_order_id returned — reconcile against GTT list', res.value));
    }
    this.tracked.set(o.positionId, {
      positionId: o.positionId, gttOrderId: gttId, instrumentKey: o.instrumentKey,
      side: o.side, product: o.product, entryDone: false, exitDone: false,
      manualExitOrderId: null, flattenFrom: null,
    });
    return ok({ gttOrderId: gttId });
  }

  /**
   * Resume following a journaled position after a restart. Fills are still
   * read from today's order book and the GTT — nothing is assumed.
   */
  adopt(a: {
    readonly positionId: PositionId; readonly gttOrderId: string; readonly instrumentKey: string;
    readonly side: Side; readonly product: string; readonly entryDone: boolean;
  }): void {
    this.tracked.set(a.positionId, {
      ...a, exitDone: false, manualExitOrderId: null, flattenFrom: null,
    });
  }

  async cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>> {
    const res = await this.client.cancelGtt(gttOrderId);
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    return ok(undefined);
  }

  /**
   * Exits are allowed whenever we hold the position, armed or not: an expired
   * arm must never strand a real position that it opened.
   */
  async exitPosition(req: ExitRequest): Promise<Result<OrderAck, BrokerError>> {
    const t = this.tracked.get(req.positionId);
    if (!t || !t.entryDone || t.exitDone) {
      return err(new BrokerError('REJECTED', `no open live position ${req.positionId} to exit`));
    }
    const r = await this.sendOrder({
      quantity: req.quantity, product: req.product, validity: 'DAY', price: 0,
      tag: `x-${req.positionId}`.slice(0, 20), instrument_token: req.instrumentKey,
      order_type: 'MARKET', transaction_type: req.side, disclosed_quantity: 0,
      trigger_price: 0, is_amo: false, slice: false, market_protection: MARKET_PROTECTION,
    });
    if (r.ok) t.manualExitOrderId = r.value.brokerOrderId;
    return r;
  }

  /** Coalesce concurrent callers (timer + stream events) into one pull. */
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => { this.syncing = null; });
    }
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    const open = [...this.tracked.values()].filter((t) => !t.exitDone);
    if (open.length === 0) return;

    const book = await this.client.orderBook();
    if (!book.ok) return;
    const byId = new Map(book.value.map((o) => [o.order_id, o]));

    for (const t of open) {
      let rules: readonly schemas.GttRule[] = [];
      if (!t.exitDone && t.manualExitOrderId === null && t.flattenFrom === null) {
        const g = await this.client.getGtt(t.gttOrderId);
        if (g.ok) rules = g.value.find((d) => d.gtt_order_id === t.gttOrderId)?.rules ?? [];
      }
      this.applyEntry(t, rules, byId);
      if (t.entryDone) this.applyExit(t, rules, book.value, byId);
      if (t.exitDone) this.tracked.delete(t.positionId);
    }
  }

  private applyEntry(
    t: Tracked,
    rules: readonly schemas.GttRule[],
    byId: ReadonlyMap<string, schemas.OrderBookEntry>,
  ): void {
    if (t.entryDone) return;
    const rule = rules.find((r) => r.strategy === 'ENTRY');
    if (!rule) return;
    const order = rule.order_id ? byId.get(rule.order_id) : undefined;
    const filled = order?.filled_quantity ?? 0;

    if (order && lc(order.status) === 'complete' && filled > 0) {
      t.entryDone = true;
      this.emit({
        kind: 'ENTRY_FILLED', positionId: t.positionId, quantity: filled,
        avgPrice: rupeesToPaise(order.average_price ?? 0), at: this.clock.ms(),
      });
      return;
    }
    const orderDead = order && (lc(order.status) === 'rejected' || lc(order.status) === 'cancelled');
    if ((orderDead && filled === 0) || (!order && FAILED_RULE.has((rule.status ?? '').toUpperCase()))) {
      t.exitDone = true; // nothing held, stop tracking
      this.emit({
        kind: 'ENTRY_FAILED', positionId: t.positionId,
        reason: order?.status_message ?? rule.message ?? `entry ${rule.status ?? order?.status}`,
        at: this.clock.ms(),
      });
    }
  }

  private applyExit(
    t: Tracked,
    rules: readonly schemas.GttRule[],
    book: readonly schemas.OrderBookEntry[],
    byId: ReadonlyMap<string, schemas.OrderBookEntry>,
  ): void {
    const done = (o: schemas.OrderBookEntry | undefined, leg: ExitLeg): boolean => {
      if (!o || lc(o.status) !== 'complete' || (o.filled_quantity ?? 0) <= 0) return false;
      t.exitDone = true;
      this.emit({
        kind: 'EXIT_FILLED', positionId: t.positionId, leg,
        quantity: o.filled_quantity ?? 0,
        avgPrice: rupeesToPaise(o.average_price ?? 0) as Paise, at: this.clock.ms(),
      });
      return true;
    };

    if (t.manualExitOrderId && done(byId.get(t.manualExitOrderId), 'MANUAL')) return;

    if (t.flattenFrom) {
      const exitSide = t.side === 'BUY' ? 'SELL' : 'BUY';
      const fill = book.find((o) => !t.flattenFrom!.has(o.order_id)
        && o.instrument_token === t.instrumentKey && o.transaction_type === exitSide);
      if (done(fill, 'MANUAL')) return;
    }

    for (const leg of ['TARGET', 'STOPLOSS'] as const) {
      const rule = rules.find((r) => r.strategy === leg);
      if (rule?.order_id && done(byId.get(rule.order_id), leg)) return;
    }
  }

  async openOrders(): Promise<Result<readonly Fill[], BrokerError>> {
    const res = await this.client.orderBook();
    if (!res.ok) {
      return err(new BrokerError('TRANSPORT', res.error.message, res.error.body));
    }
    const fills: Fill[] = res.value.map((o) => ({
      brokerOrderId: o.order_id,
      instrumentKey: o.instrument_token ?? '',
      side: o.transaction_type === 'SELL' ? 'SELL' : 'BUY',
      filledQuantity: o.filled_quantity ?? 0,
      averagePrice: rupeesToPaise(o.average_price ?? 0),
      status: o.status,
      at: o.order_timestamp ? new Date(o.order_timestamp).getTime() : this.clock.ms(),
    }));
    return ok(fills);
  }

  /**
   * Flatten the account: cancel our brackets, then Upstox's exit-all, which
   * also catches positions opened outside the engine. Fills are attributed to
   * our positions by the next sync.
   */
  async exitAllPositions(): Promise<Result<number, BrokerError>> {
    const before = await this.client.orderBook();
    const known = new Set(before.ok ? before.value.map((o) => o.order_id) : []);
    for (const t of this.tracked.values()) {
      if (t.exitDone) continue;
      await this.client.cancelGtt(t.gttOrderId);
      if (t.entryDone) t.flattenFrom = known;
    }
    const res = await this.client.exitAllPositions();
    if (!res.ok) {
      return err(new BrokerError('REJECTED', res.error.message, res.error.body));
    }
    const ids = (res.value as { data?: { order_ids?: string[] } })?.data?.order_ids ?? [];
    return ok(ids.length);
  }

  /** Positions still being followed, for diagnostics and the kill switch. */
  trackedCount(): number {
    return [...this.tracked.values()].filter((t) => !t.exitDone).length;
  }
}
