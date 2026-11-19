import {
  type Clock, type Paise, type Product, type Side, type PositionId, type TradingStyle,
  newPositionId, istDateKey, istMinutes, SESSION, rupeesToPaise, isTerminal,
} from '@tradeforger/core';
import type { BrokerPort, BrokerEvent, ExitLeg } from '@tradeforger/broker';
import { PositionMachine, type PositionRecord } from '@tradeforger/execution';

export type Segment = 'EQ' | 'FO';

export interface ContractInfo {
  readonly tradingSymbol: string;
  readonly instrumentType: 'CE' | 'PE' | 'FUT';
  readonly strike: number | null;
  readonly expiry: string;
  readonly lotSize: number;
  readonly lots: number;
}

/** Everything needed to open a position. Risk and AI gates have already passed. */
export interface TradeIntent {
  readonly segment: Segment;
  readonly style: TradingStyle;
  readonly signalId: string;
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: number;
  readonly product: Product;
  readonly entry: Paise;
  readonly stopLoss: Paise;
  readonly target: Paise;
  readonly trailingGap: Paise | null;
  /** Capital this position locks up — premium for options, margin for futures. */
  readonly costPaise: Paise;
  /** Exit a flat-or-losing position after this many minutes (theta guard). */
  readonly timeStopMin: number | null;
  readonly contract?: ContractInfo;
  readonly underlyingSymbol?: string;
  /** Catalog strategy and registry version that produced the setup. */
  readonly strategyId?: string;
  readonly strategyVersion?: string;
  /** Hybrid setup quality (0-100) at entry. */
  readonly quality?: number;
}

export interface ManagedPosition extends PositionRecord {
  readonly segment: Segment;
  readonly style: TradingStyle;
  readonly signalId: string;
  readonly product: Product;
  readonly costPaise: Paise;
  readonly timeStopMin: number | null;
  readonly trailingGap: Paise | null;
  readonly contract?: ContractInfo;
  readonly underlyingSymbol?: string;
  readonly strategyId?: string;
  readonly strategyVersion?: string;
  readonly quality?: number;
  /** Best and worst per-unit excursion from the fill while open, paise (MFE ≥ 0, MAE ≤ 0). */
  mfePaise: number;
  maePaise: number;
  filledAt: number | null;
  exitPrice: Paise | null;
  exitReason: string | null;
  realisedPnl: Paise | null;
  closedAt: number | null;
}

export interface TraderDeps {
  readonly clock: Clock;
  readonly broker: BrokerPort;
  readonly machine: PositionMachine;
  readonly perTradeLossPaise: () => Paise;
  readonly log?: (msg: string) => void;
  readonly onClosed?: (p: ManagedPosition) => void;
}

const LIVE_STATES = new Set(['ENTRY_SENT', 'ENTRY_ACKED', 'ENTRY_FILLED', 'BRACKET_ARMED', 'MANAGING', 'EXIT_TRIGGERED', 'ORPHANED']);
const REJECT_WINDOW_MS = 5 * 60_000;

/**
 * Sole owner of position state.
 *
 * Every mutation — opening a trade, a broker event, an exit — runs through one
 * serial queue, so a fill event can never interleave with the placement that
 * caused it, and two decision paths can never both see "flat" and both enter.
 *
 * Positions change state ONLY on broker events. An acknowledged order is not a
 * filled one, and the previous engine's habit of assuming otherwise left live
 * positions without stops.
 */
export class Trader {
  readonly positions = new Map<string, ManagedPosition>();
  private readonly d: TraderDeps;
  private queue: Promise<unknown> = Promise.resolve();

  private day = '';
  realisedPnl = 0 as Paise;
  consecutiveLosses = 0;
  private orderTimes: number[] = [];
  private rejectTimes: number[] = [];

  constructor(deps: TraderDeps) {
    this.d = deps;
    deps.broker.onEvent((e) => { void this.serial(() => this.apply(e)); });
    this.rollDay();
  }

  private log(msg: string): void {
    (this.d.log ?? console.log)(msg);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Daily counters reset on the IST date, which is what the exchange runs on. */
  rollDay(): void {
    const today = istDateKey(this.d.clock.now());
    if (today === this.day) return;
    this.day = today;
    this.realisedPnl = 0 as Paise;
    this.consecutiveLosses = 0;
    this.orderTimes = [];
    this.rejectTimes = [];
  }

  get ordersToday(): number { return this.orderTimes.length; }
  get orderTimestamps(): readonly number[] { return this.orderTimes; }
  get rejectsLast5Min(): number {
    const cutoff = this.d.clock.ms() - REJECT_WINDOW_MS;
    return this.rejectTimes.filter((t) => t >= cutoff).length;
  }

  live(): ManagedPosition[] {
    return [...this.positions.values()].filter((p) => LIVE_STATES.has(p.state));
  }

  hasOrphan(): boolean {
    return [...this.positions.values()].some((p) => p.state === 'ORPHANED');
  }

  /** Open or pending in this instrument — at most one at a time. */
  holds(instrumentKey: string): boolean {
    return this.live().some((p) => p.instrumentKey === instrumentKey);
  }

  deployed(): Paise {
    return this.live().reduce((s, p) => s + p.costPaise, 0) as Paise;
  }

  unrealised(p: ManagedPosition, ltp: number | null): Paise {
    if (p.filledQuantity <= 0 || p.avgEntry === null || ltp === null || ltp <= 0) return 0 as Paise;
    const px = rupeesToPaise(ltp);
    return ((p.side === 'BUY' ? px - p.avgEntry : p.avgEntry - px) * p.filledQuantity) as Paise;
  }

  open(intent: TradeIntent): Promise<{ ok: true; position: ManagedPosition } | { ok: false; reason: string }> {
    return this.serial(async () => {
      this.rollDay();
      if (this.holds(intent.instrumentKey)) return { ok: false, reason: `already in ${intent.symbol}` };
      if (intent.quantity < 1) return { ok: false, reason: 'quantity below 1' };

      const p: ManagedPosition = {
        id: newPositionId(),
        instrumentKey: intent.instrumentKey,
        symbol: intent.symbol,
        side: intent.side,
        state: 'CANDIDATE',
        quantity: intent.quantity,
        filledQuantity: 0,
        entry: intent.entry,
        avgEntry: null,
        stopLoss: intent.stopLoss,
        target: intent.target,
        entryOrderId: null,
        gttOrderId: null,
        openedAt: this.d.clock.ms(),
        segment: intent.segment,
        style: intent.style,
        signalId: intent.signalId,
        product: intent.product,
        costPaise: intent.costPaise,
        timeStopMin: intent.timeStopMin,
        trailingGap: intent.trailingGap,
        ...(intent.contract ? { contract: intent.contract } : {}),
        ...(intent.underlyingSymbol ? { underlyingSymbol: intent.underlyingSymbol } : {}),
        ...(intent.strategyId ? { strategyId: intent.strategyId } : {}),
        ...(intent.strategyVersion ? { strategyVersion: intent.strategyVersion } : {}),
        ...(intent.quality !== undefined ? { quality: intent.quality } : {}),
        mfePaise: 0,
        maePaise: 0,
        filledAt: null,
        exitPrice: null,
        exitReason: null,
        realisedPnl: null,
        closedAt: null,
      };
      this.positions.set(p.id, p);

      const m = this.d.machine;
      await m.transition(p, 'AI_REVIEWED');
      await m.transition(p, 'RISK_APPROVED');
      await m.transition(p, 'ENTRY_SENT');
      this.orderTimes.push(this.d.clock.ms());

      const r = await this.d.broker.placeBracketOrder({
        positionId: p.id,
        instrumentKey: p.instrumentKey,
        side: p.side,
        quantity: p.quantity,
        product: p.product,
        entryTrigger: 'IMMEDIATE',
        entryPrice: p.entry,
        targetPrice: p.target,
        stopLossPrice: p.stopLoss,
        ...(intent.trailingGap ? { trailingGap: intent.trailingGap } : {}),
      });

      if (!r.ok) {
        if (r.error.kind === 'TRANSPORT') {
          // Outcome unknown: the exchange may hold this order. Treat it as an
          // unprotected position until a human has looked at the order book.
          await m.orphan(p, `ambiguous placement: ${r.error.message}`);
        } else {
          if (r.error.kind === 'REJECTED') this.rejectTimes.push(this.d.clock.ms());
          p.exitReason = r.error.message;
          await m.transition(p, 'REJECTED');
        }
        return { ok: false, reason: r.error.message };
      }

      p.gttOrderId = r.value.gttOrderId;
      await m.transition(p, 'ENTRY_ACKED');
      return { ok: true, position: p };
    });
  }

  private async apply(e: BrokerEvent): Promise<void> {
    const p = this.positions.get(e.positionId);
    if (!p) {
      this.log(`[broker] event for unknown position ${e.positionId} (${e.kind})`);
      return;
    }
    const m = this.d.machine;

    switch (e.kind) {
      case 'ENTRY_FILLED': {
        if (p.state !== 'ENTRY_ACKED' && p.state !== 'ENTRY_SENT') return;
        if (p.state === 'ENTRY_SENT') await m.transition(p, 'ENTRY_ACKED');
        p.filledQuantity = e.quantity;
        p.avgEntry = e.avgPrice;
        p.filledAt = e.at;
        await m.transition(p, 'ENTRY_FILLED');
        // Exit legs belong to the same GTT, so they are live the moment the entry fills.
        await m.transition(p, 'BRACKET_ARMED');
        await m.transition(p, 'MANAGING');
        if (e.quantity !== p.quantity) {
          this.log(`[partial] ${p.symbol} filled ${e.quantity}/${p.quantity}`);
        }
        this.log(`[TRADE OPEN] ${p.contract?.tradingSymbol ?? p.symbol} ${p.side} x${e.quantity} @ ₹${(e.avgPrice / 100).toFixed(2)}`);
        return;
      }
      case 'ENTRY_FAILED': {
        if (p.state !== 'ENTRY_ACKED' && p.state !== 'ENTRY_SENT') return;
        p.exitReason = e.reason;
        await m.transition(p, 'CANCELLED');
        this.rejectTimes.push(e.at);
        return;
      }
      case 'EXIT_FILLED': {
        if (isTerminal(p.state)) return;
        await this.book(p, e.leg, e.avgPrice, e.quantity, e.at);
        return;
      }
    }
  }

  private async book(p: ManagedPosition, leg: ExitLeg, price: Paise, qty: number, at: number): Promise<void> {
    const m = this.d.machine;
    if (p.state === 'MANAGING') await m.transition(p, 'EXIT_TRIGGERED');
    if (p.state === 'EXIT_TRIGGERED') await m.transition(p, 'EXIT_FILLED');
    const entry = p.avgEntry ?? p.entry;
    this.excursion(p, price);
    const pnl = ((p.side === 'BUY' ? price - entry : entry - price) * qty) as Paise;
    p.exitPrice = price;
    p.exitReason ??= leg;
    p.realisedPnl = pnl;
    p.closedAt = at;
    this.orderTimes.push(at);
    this.realisedPnl = (this.realisedPnl + pnl) as Paise;
    this.consecutiveLosses = pnl < 0 ? this.consecutiveLosses + 1 : 0;
    await m.transition(p, 'CLOSED');
    this.log(`[TRADE CLOSED] ${p.contract?.tradingSymbol ?? p.symbol} ${p.exitReason} @ ₹${(price / 100).toFixed(2)} P&L ₹${(pnl / 100).toFixed(2)}`);
    this.d.onClosed?.(p);
  }

  /**
   * Exit one position outside its bracket.
   *
   * The bracket is cancelled FIRST. If that fails, a leg has probably already
   * fired — sending our own exit as well would close the position twice and
   * leave it reversed, so we wait for the leg's fill instead.
   */
  exit(positionId: string, reason: string): Promise<{ ok: boolean; detail: string }> {
    return this.serial(async () => {
      const p = this.positions.get(positionId);
      if (!p) return { ok: false, detail: 'position not found' };
      const m = this.d.machine;

      if (p.state === 'ENTRY_ACKED' && p.gttOrderId) {
        const c = await this.d.broker.cancelBracket(p.gttOrderId);
        await this.d.broker.sync();
        return c.ok ? { ok: true, detail: 'pending entry cancelled' } : { ok: false, detail: c.error.message };
      }
      if (p.state !== 'MANAGING') return { ok: false, detail: `cannot exit from ${p.state}` };

      p.exitReason = reason;
      await m.transition(p, 'EXIT_TRIGGERED');
      if (p.gttOrderId) {
        const c = await this.d.broker.cancelBracket(p.gttOrderId);
        if (!c.ok) {
          await this.d.broker.sync();
          return { ok: true, detail: `bracket not cancellable (${c.error.message}); awaiting its fill` };
        }
      }
      const r = await this.d.broker.exitPosition({
        positionId: p.id,
        instrumentKey: p.instrumentKey,
        side: p.side === 'BUY' ? 'SELL' : 'BUY',
        quantity: p.filledQuantity,
        product: p.product,
      });
      if (!r.ok) {
        // Bracket gone and exit refused: an unprotected position. Halt.
        await m.orphan(p, `exit failed after bracket cancel: ${r.error.message}`);
        return { ok: false, detail: r.error.message };
      }
      return { ok: true, detail: 'exit sent' };
    });
  }

  /** Track how far a position went for and against us — the MAE/MFE of the trade log. */
  private excursion(p: ManagedPosition, price: number): void {
    if (p.avgEntry === null) return;
    const move = p.side === 'BUY' ? price - p.avgEntry : p.avgEntry - price;
    p.mfePaise = Math.max(p.mfePaise, move);
    p.maePaise = Math.min(p.maePaise, move);
  }

  /** Kill switch: mark everything exiting, then let the broker flatten. */
  flattenAll(): Promise<number> {
    return this.serial(async () => {
      for (const p of this.live()) {
        if (p.state === 'MANAGING') {
          p.exitReason = 'KILL_SWITCH';
          await this.d.machine.transition(p, 'EXIT_TRIGGERED');
        }
      }
      const r = await this.d.broker.exitAllPositions();
      await this.d.broker.sync();
      return r.ok ? r.value : 0;
    });
  }

  /**
   * Time-driven exits, run every second. Exits are risk-REDUCING, so they run
   * even when entry breakers are tripped.
   */
  async manage(ltpOf: (key: string) => number | null): Promise<void> {
    this.rollDay();
    const now = this.d.clock.ms();
    const mins = istMinutes(this.d.clock.now());
    const perTrade = this.d.perTradeLossPaise();

    for (const p of this.live()) {
      if (p.state === 'ENTRY_ACKED' && p.product === 'I' && mins >= SESSION.SQUARE_OFF) {
        await this.exit(p.id, 'EOD_CANCEL');
        continue;
      }
      if (p.state !== 'MANAGING') continue;
      const ltp = ltpOf(p.instrumentKey);
      if (ltp !== null && ltp > 0) this.excursion(p, rupeesToPaise(ltp));

      if (p.product === 'I' && mins >= SESSION.SQUARE_OFF) {
        await this.exit(p.id, 'EOD_SQUARE_OFF');
        continue;
      }
      const pnl = this.unrealised(p, ltp);
      if (perTrade > 0 && -pnl >= perTrade) {
        await this.exit(p.id, 'PER_TRADE_LOSS');
        continue;
      }
      if (p.timeStopMin !== null && p.filledAt !== null
        && now - p.filledAt >= p.timeStopMin * 60_000 && pnl <= 0) {
        await this.exit(p.id, 'TIME_STOP');
      }
    }
  }
}

export type { PositionId };
