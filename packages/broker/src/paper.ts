import {
  type Result, ok, err, type OrderRequest, type OrderAck, type Fill,
  type Paise, type Mode, type Clock, type Tick, rupeesToPaise,
} from '@tradeforger/core';
import { BrokerError, type BrokerPort, type BracketSpec, type BracketAck } from './port.ts';

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
  readonly spec: BracketSpec;
  active: boolean;
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

  async placeBracket(spec: BracketSpec): Promise<Result<BracketAck, BrokerError>> {
    if (spec.quantity < 1) {
      return err(new BrokerError('REJECTED', 'bracket quantity below 1'));
    }
    const id = this.nextId('gtt');
    this.brackets.set(id, { id, spec, active: true });
    return ok({ gttOrderId: id });
  }

  async cancelBracket(gttOrderId: string): Promise<Result<void, BrokerError>> {
    const b = this.brackets.get(gttOrderId);
    if (!b) return err(new BrokerError('REJECTED', `unknown GTT ${gttOrderId}`));
    b.active = false;
    return ok(undefined);
  }

  /**
   * Resolve brackets against a tick. Mirrors Upstox's GTT MULTIPLE semantics:
   * whichever leg triggers first wins and the sibling is cancelled together
   * with it, because both legs belong to one GTT order.
   */
  private settleBrackets(tick: Tick): void {
    const ltp = rupeesToPaise(tick.ltp);
    for (const b of this.brackets.values()) {
      if (!b.active || b.spec.instrumentKey !== tick.instrumentKey) continue;

      // A long position exits by SELLing: target above, stop below.
      const long = b.spec.exitSide === 'SELL';
      const hitTarget = long ? ltp >= b.spec.targetPrice : ltp <= b.spec.targetPrice;
      const hitStop = long ? ltp <= b.spec.stopLossPrice : ltp >= b.spec.stopLossPrice;

      if (hitTarget || hitStop) {
        // A tick is a point, so for a well-formed bracket (target beyond stop)
        // only one leg can match. Both match only if the bracket is inverted —
        // target on the wrong side of stop. Preferring the stop there means a
        // malformed bracket exits at the worse price rather than booking a
        // phantom profit, which is the safe way to be wrong.
        const price = hitStop ? b.spec.stopLossPrice : b.spec.targetPrice;
        const id = this.nextId('paper');
        this.orders.set(id, {
          id,
          req: {
            positionId: '' as never,
            instrumentKey: b.spec.instrumentKey,
            side: b.spec.exitSide,
            quantity: b.spec.quantity,
            orderType: 'MARKET',
            product: b.spec.product,
            validity: 'DAY',
            price,
            triggerPrice: price,
            tag: `exit-${b.id}`,
          },
          status: 'FILLED',
          filledQuantity: b.spec.quantity,
          averagePrice: this.applySlippage(price, b.spec.exitSide),
          placedAt: this.clock.ms(),
        });
        b.active = false;
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

  async exitAllPositions(): Promise<Result<number, BrokerError>> {
    let n = 0;
    for (const b of this.brackets.values()) {
      if (b.active) { b.active = false; n++; }
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
      activeBrackets: [...this.brackets.values()].filter((b) => b.active).length,
    };
  }
}
