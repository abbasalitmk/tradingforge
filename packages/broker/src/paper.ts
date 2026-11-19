import {
  type Result, ok, err, type OrderRequest, type OrderAck, type Fill,
  type Paise, type Mode, type Clock, type Tick, rupeesToPaise,
} from '@tradeforger/core';
import {
  BrokerError, type BrokerPort, type BracketOrder, type BracketAck,
  type BrokerEvent, type BrokerListener, type ExitRequest, type ExitLeg,
} from './port.ts';

export interface PaperConfig {
  /** Slippage applied against us, in basis points. Market orders in NSE
   *  equities typically see 2-8bps on liquid names; 5 is a fair default. */
  readonly slippageBps: number;
  /** Probability a market order fills only partially, per fill attempt. */
  readonly partialFillProbability: number;
  /** Simulated round-trip latency before an order is acknowledged. */
  readonly latencyMs: number;
  /** Deterministic seed, so a replay produces identical fills. */
  readonly seed: number;
}

export const DEFAULT_PAPER_CONFIG: PaperConfig = {
  slippageBps: 5,
  partialFillProbability: 0.1,
  latencyMs: 120,
  seed: 42,
};

/** Mulberry32 — small, fast, and deterministic from a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PaperOrder {
  readonly id: string;
  readonly req: OrderRequest;
  status: 'PENDING' | 'FILLED' | 'PARTIAL' | 'CANCELLED';
  filledQuantity: number;
  averagePrice: Paise;
  readonly placedAt: number;
}

interface PaperBracket {
  readonly id: string;
  readonly order: BracketOrder;
  status: 'PENDING_ENTRY' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  /** Live stop level — moves only in the favourable direction when trailing. */
  stop: Paise;
  fillPrice: Paise | null;
}

/**
 * Deterministic fill simulator.
 *
 * This — not the Upstox sandbox — is the real test bed. The sandbox exposes
 * only seven order endpoints and no market data, so it cannot price a fill or
 * run a strategy loop (docs/00-PLAN.md §0.3). This port consumes the live tick
 * feed and models the things that actually erode a backtest's edge: slippage
 * against you, partial fills, and the gap between signal price and fill price.
 *
 * Deliberately pessimistic. A paper run that looks worse than reality is safe;
 * one that looks better is how a strategy reaches live money and loses it.
 */
export class PaperBroker implements BrokerPort {
  readonly mode: Mode = 'PAPER';
  readonly isLive = false;

  private readonly orders = new Map<string, PaperOrder>();
  private readonly brackets = new Map<string, PaperBracket>();
  private readonly lastTick = new Map<string, Tick>();
  private readonly clock: Clock;
  private readonly cfg: PaperConfig;
  private readonly rand: () => number;
  private readonly listeners: BrokerListener[] = [];
  private seq = 0;

  constructor(clock: Clock, cfg: PaperConfig = DEFAULT_PAPER_CONFIG) {
    this.clock = clock;
    this.cfg = cfg;
    this.rand = rng(cfg.seed);
  }

  /** Feed the simulator prices. Without a tick it refuses to fill — the
   *  fabricated-price failure mode that made stockwatch unsafe. */
  onTick(t: Tick): void {
    this.lastTick.set(t.instrumentKey, t);
    this.settleBrackets(t);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, '0')}`;
  }

  /** Slippage always moves against the trader. */
  private applySlippage(price: Paise, side: 'BUY' | 'SELL'): Paise {
    const drift = Math.round((price * this.cfg.slippageBps) / 10_000);
    return (side === 'BUY' ? price + drift : price - drift) as Paise;
  }

  async placeOrder(req: OrderRequest): Promise<Result<OrderAck, BrokerError>> {
    const tick = this.lastTick.get(req.instrumentKey);
    if (!tick) {
      return err(new BrokerError(
        'BLOCKED',
        `no market data for ${req.instrumentKey} — refusing to invent a fill price`,
      ));
    }
    if (req.quantity < 1) {
      return err(new BrokerError('REJECTED', `quantity ${req.quantity} below 1`));
    }

    if (this.cfg.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.cfg.latencyMs));
    }

    const id = this.nextId('paper');
    const ltp = rupeesToPaise(tick.ltp);

    const order: PaperOrder = {
      id, req, status: 'PENDING', filledQuantity: 0,
      averagePrice: 0 as Paise, placedAt: this.clock.ms(),
    };

    if (req.orderType === 'MARKET') {
      const partial = this.rand() < this.cfg.partialFillProbability;
      const qty = partial ? Math.max(1, Math.floor(req.quantity * (0.3 + this.rand() * 0.5))) : req.quantity;
      order.filledQuantity = qty;
      order.averagePrice = this.applySlippage(ltp, req.side);
      order.status = qty === req.quantity ? 'FILLED' : 'PARTIAL';
    } else if (req.orderType === 'LIMIT') {
      // Fills only if the market is already at or through the limit. A resting
      // limit order is left PENDING and resolved by a later tick.
      const crossed = req.side === 'BUY' ? ltp <= req.price : ltp >= req.price;
      if (crossed) {
        order.filledQuantity = req.quantity;
        order.averagePrice = req.price;
        order.status = 'FILLED';
      }
    }

    this.orders.set(id, order);
    return ok({ brokerOrderId: id, acceptedAt: this.clock.ms() });
  }

  async cancelOrder(brokerOrderId: string): Promise<Result<void, BrokerError>> {
    const o = this.orders.get(brokerOrderId);
    if (!o) return err(new BrokerError('REJECTED', `unknown order ${brokerOrderId}`));
    if (o.status === 'FILLED') {
      return err(new BrokerError('REJECTED', `order ${brokerOrderId} already filled`));
    }
    o.status = 'CANCELLED';
    return ok(undefined);
  }

  onEvent(listener: BrokerListener): void {
    this.listeners.push(listener);
  }

  private emit(e: BrokerEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Paper state is always current; nothing to pull. */
  async sync(): Promise<void> {}

  async placeBracketOrder(o: BracketOrder): Promise<Result<BracketAck, BrokerError>> {
    if (o.quantity < 1) {
      return err(new BrokerError('REJECTED', 'bracket quantity below 1'));
    }
    // Reject an inverted bracket outright rather than guessing which leg the
    // caller meant. Upstox validates leg geometry too.
    const long = o.side === 'BUY';
    const ordered = long
      ? o.targetPrice > o.entryPrice && o.stopLossPrice < o.entryPrice
      : o.targetPrice < o.entryPrice && o.stopLossPrice > o.entryPrice;
    if (!ordered) {
      return err(new BrokerError('REJECTED', `bracket legs on the wrong side of entry for a ${o.side}`));
    }
    const tick = this.lastTick.get(o.instrumentKey);
    if (!tick) {
      return err(new BrokerError(
        'BLOCKED',
        `no market data for ${o.instrumentKey} — refusing to invent a fill price`,
      ));
    }
    if (this.cfg.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.cfg.latencyMs));
    }

    const id = this.nextId('gtt');
    const b: PaperBracket = { id, order: o, status: 'PENDING_ENTRY', stop: o.stopLossPrice, fillPrice: null };
    this.brackets.set(id, b);
    if (o.entryTrigger === 'IMMEDIATE') this.fillEntry(b, rupeesToPaise(tick.ltp));
    return ok({ gttOrderId: id });
  }

  private fillEntry(b: PaperBracket, ltp: Paise): void {
    const price = this.applySlippage(ltp, b.order.side);
    b.status = 'OPEN';
    b.fillPrice = price;
    this.emit({
      kind: 'ENTRY_FILLED', positionId: b.order.positionId,
      quantity: b.order.quantity, avgPrice: price, at: this.clock.ms(),
    });
  }

  private closeBracket(b: PaperBracket, leg: ExitLeg, price: Paise): void {
    const exitSide = b.order.side === 'BUY' ? 'SELL' : 'BUY';
    const id = this.nextId('paper');
    this.orders.set(id, {
      id,
      req: {
        positionId: b.order.positionId,
        instrumentKey: b.order.instrumentKey,
        side: exitSide,
        quantity: b.order.quantity,
        orderType: 'MARKET',
        product: b.order.product,
        validity: 'DAY',
        price,
        triggerPrice: price,
        tag: `exit-${b.id}`,
      },
      status: 'FILLED',
      filledQuantity: b.order.quantity,
      averagePrice: price,
      placedAt: this.clock.ms(),
    });
    b.status = 'CLOSED';
    this.emit({
      kind: 'EXIT_FILLED', positionId: b.order.positionId, leg,
      quantity: b.order.quantity, avgPrice: price, at: this.clock.ms(),
    });
  }

  async cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>> {
    const b = this.brackets.get(gttOrderId);
    if (!b) return err(new BrokerError('REJECTED', `unknown GTT ${gttOrderId}`));
    if (b.status === 'CLOSED' || b.status === 'CANCELLED') {
      return err(new BrokerError('REJECTED', `GTT ${gttOrderId} already ${b.status.toLowerCase()}`));
    }
    const wasPending = b.status === 'PENDING_ENTRY';
    b.status = 'CANCELLED';
    if (wasPending) {
      this.emit({ kind: 'ENTRY_FAILED', positionId: b.order.positionId, reason: 'cancelled before entry', at: this.clock.ms() });
    }
    return ok(undefined);
  }

  async exitPosition(req: ExitRequest): Promise<Result<OrderAck, BrokerError>> {
    const tick = this.lastTick.get(req.instrumentKey);
    if (!tick) {
      return err(new BrokerError('BLOCKED', `no market data for ${req.instrumentKey} — cannot price the exit`));
    }
    const price = this.applySlippage(rupeesToPaise(tick.ltp), req.side);
    const id = this.nextId('paper');
    this.orders.set(id, {
      id,
      req: {
        positionId: req.positionId, instrumentKey: req.instrumentKey, side: req.side,
        quantity: req.quantity, orderType: 'MARKET', product: req.product, validity: 'DAY',
        price, triggerPrice: price, tag: `exit-${req.positionId}`,
      },
      status: 'FILLED', filledQuantity: req.quantity, averagePrice: price, placedAt: this.clock.ms(),
    });
    this.emit({
      kind: 'EXIT_FILLED', positionId: req.positionId, leg: 'MANUAL',
      quantity: req.quantity, avgPrice: price, at: this.clock.ms(),
    });
    return ok({ brokerOrderId: id, acceptedAt: this.clock.ms() });
  }

  /**
   * Resolve brackets against a tick, mirroring GTT MULTIPLE: a pending entry
   * triggers on its level; once open, whichever exit leg triggers first closes
   * the whole bracket.
   *
   * The stop fills at the tick that crossed it, not at the stop level — a gap
   * through the stop costs the gap, which is what happens on the exchange. The
   * target fills at its level and never better. Both choices are pessimistic.
   */
  private settleBrackets(tick: Tick): void {
    const ltp = rupeesToPaise(tick.ltp);
    for (const b of this.brackets.values()) {
      if (b.order.instrumentKey !== tick.instrumentKey) continue;
      const o = b.order;
      const long = o.side === 'BUY';

      if (b.status === 'PENDING_ENTRY') {
        const triggered = o.entryTrigger === 'ABOVE' ? ltp >= o.entryPrice
          : o.entryTrigger === 'BELOW' ? ltp <= o.entryPrice
          : true;
        if (triggered) this.fillEntry(b, ltp);
        continue;
      }
      if (b.status !== 'OPEN') continue;

      if (o.trailingGap !== undefined && o.trailingGap > 0) {
        const trailed = (long ? ltp - o.trailingGap : ltp + o.trailingGap) as Paise;
        b.stop = (long ? Math.max(b.stop, trailed) : Math.min(b.stop, trailed)) as Paise;
      }

      const hitStop = long ? ltp <= b.stop : ltp >= b.stop;
      const hitTarget = long ? ltp >= o.targetPrice : ltp <= o.targetPrice;
      if (hitStop) {
        this.closeBracket(b, 'STOPLOSS', this.applySlippage(ltp, long ? 'SELL' : 'BUY'));
      } else if (hitTarget) {
        this.closeBracket(b, 'TARGET', o.targetPrice);
      }
    }
  }

  async openOrders(): Promise<Result<readonly Fill[], BrokerError>> {
    const fills: Fill[] = [...this.orders.values()].map((o) => ({
      brokerOrderId: o.id,
      instrumentKey: o.req.instrumentKey,
      side: o.req.side,
      filledQuantity: o.filledQuantity,
      averagePrice: o.averagePrice,
      status: o.status,
      at: o.placedAt,
    }));
    return ok(fills);
  }

  /** Flatten everything: open brackets exit at market, pending entries are cancelled. */
  async exitAllPositions(): Promise<Result<number, BrokerError>> {
    let n = 0;
    for (const b of this.brackets.values()) {
      if (b.status === 'PENDING_ENTRY') {
        await this.cancelBracket(b.id);
      } else if (b.status === 'OPEN') {
        const tick = this.lastTick.get(b.order.instrumentKey);
        const ltp = tick ? rupeesToPaise(tick.ltp) : (b.fillPrice ?? b.order.entryPrice);
        this.closeBracket(b, 'MANUAL', this.applySlippage(ltp, b.order.side === 'BUY' ? 'SELL' : 'BUY'));
        n++;
      }
    }
    for (const o of this.orders.values()) {
      if (o.status === 'PENDING') o.status = 'CANCELLED';
    }
    return ok(n);
  }

  /** Test/inspection helper — not part of BrokerPort. */
  inspect(): { orders: number; activeBrackets: number } {
    return {
      orders: this.orders.size,
      activeBrackets: [...this.brackets.values()]
        .filter((b) => b.status === 'OPEN' || b.status === 'PENDING_ENTRY').length,
    };
  }
}
