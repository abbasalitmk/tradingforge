import {
  type Clock, type Paise, type Product, type Side, type PositionId, type TradingStyle,
  newPositionId, istDateKey, istMinutes, SESSION, rupeesToPaise, isTerminal,
} from '@tradeforger/core';
import type { BrokerPort, BrokerEvent, BrokerId, ExitLeg } from '@tradeforger/broker';
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

export interface StagedTrailRule {
  readonly breakevenR: number;
  readonly breakevenLockR: number;
  readonly trailFromR: number;
  readonly trailGapPaise: Paise;
}

/**
 * No follow-through: a trade that has not gone `minMfeR` of its risk in its
 * favour within `afterMin` minutes, and is flat or losing, is closed rather
 * than left to drift into its stop. Most intraday stop-outs never got going.
 */
export interface StallRule {
  readonly afterMin: number;
  readonly minMfeR: number;
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
  readonly stagedTrail?: StagedTrailRule | null;
  /** Capital this position locks up — premium for options, margin for futures. */
  readonly costPaise: Paise;
  /** Exit a flat-or-losing position after this many minutes (theta guard). */
  readonly timeStopMin: number | null;
  readonly stall?: StallRule | null;
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
  /** The order path that opened it; every later order for it goes back there. */
  readonly broker: BrokerId;
  readonly costPaise: Paise;
  readonly timeStopMin: number | null;
  readonly stall?: StallRule | null;
  readonly trailingGap: Paise | null;
  readonly stagedTrail?: StagedTrailRule | null;
  /** Ratcheted stop level tracked by staged trailing (initial `stopLoss` stays intact as 1R reference). */
  virtualStopPaise?: Paise | null;
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

/** How a human settled an ORPHANED position after checking the broker. */
export type OrphanResolution =
  | { readonly kind: 'CLOSED'; readonly exitPrice: Paise | null; readonly note: string }
  | { readonly kind: 'MANAGING'; readonly note: string };

export interface TraderDeps {
  readonly clock: Clock;
  /** The broker new entries go to until `setBroker` says otherwise. */
  readonly broker: BrokerPort;
  readonly brokerId?: BrokerId;
  readonly machine: PositionMachine;
  readonly perTradeLossPaise: () => Paise;
  readonly log?: (msg: string) => void;
  readonly onClosed?: (p: ManagedPosition) => void;
}

/**
 * Exits a person chose — not the strategy's stop, target, time stop or the
 * session's square-off. They are real P&L, but they say nothing about whether
 * the strategy is failing, so they neither extend nor reset the loss streak.
 */
export const isOperatorExit = (reason: string | null | undefined): boolean =>
  !!reason && (reason === 'MANUAL' || reason === 'KILL_SWITCH' || reason.startsWith('RESOLVED'));

const LIVE_STATES = new Set(['ENTRY_SENT', 'ENTRY_ACKED', 'ENTRY_FILLED', 'BRACKET_ARMED', 'MANAGING', 'EXIT_TRIGGERED', 'ORPHANED']);
const REJECT_WINDOW_MS = 5 * 60_000;

interface Ledger {
  realisedPnl: Paise;
  consecutiveLosses: number;
  orderTimes: number[];
  rejectTimes: number[];
}

/** Journal rows written before positions recorded their broker were all paper. */
const brokerOfRecord = (p: { broker?: BrokerId }): BrokerId => p.broker ?? 'PAPER';
/** How far past its planned risk a position may run before the per-trade backstop takes over from the stop. */
const STOP_SLIPPAGE_ALLOWANCE = 1.15;

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
 *
 * Entries go to the active broker; everything after that goes to the broker
 * recorded on the position. Switching PAPER ↔ LIVE therefore never strands a
 * position on an order path that cannot see its fills or cancel its bracket.
 */
export class Trader {
  readonly positions = new Map<string, ManagedPosition>();
  private readonly d: TraderDeps;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly brokers = new Map<BrokerId, BrokerPort>();
  private active: BrokerId;

  private day = '';
  /**
   * Today's P&L, loss streak, orders and rejects, kept per broker: paper
   * trades are practice and must never use up LIVE's daily limits or trip its
   * loss breakers. The getters below read the active broker's ledger.
   */
  private ledgers = new Map<BrokerId, Ledger>();

  constructor(deps: TraderDeps) {
    this.d = deps;
    this.active = deps.brokerId ?? 'PAPER';
    this.register(this.active, deps.broker);
    this.rollDay();
  }

  /** Make a broker reachable for the positions recorded against it, without routing entries to it. */
  register(id: BrokerId, b: BrokerPort): void {
    if (this.brokers.get(id) === b) return;
    this.brokers.set(id, b);
    b.onEvent((e) => { void this.serial(() => this.apply(e)); });
  }

  /** Route new entries to this broker. Open positions keep their own. */
  setBroker(id: BrokerId, b: BrokerPort): void {
    this.register(id, b);
    this.active = id;
  }

  get activeBroker(): BrokerId { return this.active; }

  private brokerOf(p: ManagedPosition): BrokerPort | null {
    return this.brokers.get(p.broker) ?? null;
  }

  private log(msg: string): void {
    (this.d.log ?? console.log)(msg);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ledger(id: BrokerId = this.active): Ledger {
    let l = this.ledgers.get(id);
    if (!l) {
      l = { realisedPnl: 0 as Paise, consecutiveLosses: 0, orderTimes: [], rejectTimes: [] };
      this.ledgers.set(id, l);
    }
    return l;
  }

  /** Daily counters reset on the IST date, which is what the exchange runs on. */
  rollDay(): void {
    const today = istDateKey(this.d.clock.now());
    if (today === this.day) return;
    this.day = today;
    this.ledgers.clear();
  }

  /**
   * Re-seed today's counters from the journal after a restart. Without this a
   * crash mid-session would hand the daily-loss and consecutive-loss breakers
   * a clean slate.
   */
  restoreDay(today: readonly ManagedPosition[]): void {
    this.rollDay();
    this.ledgers.clear();
    const closed = today
      .filter((p) => p.closedAt !== null && p.realisedPnl !== null && istDateKey(new Date(p.closedAt)) === this.day)
      .sort((a, b) => a.closedAt! - b.closedAt!);
    for (const p of closed) {
      const l = this.ledger(brokerOfRecord(p));
      l.realisedPnl = (l.realisedPnl + p.realisedPnl!) as Paise;
      if (!isOperatorExit(p.exitReason)) l.consecutiveLosses = p.realisedPnl! < 0 ? l.consecutiveLosses + 1 : 0;
      l.orderTimes.push(p.closedAt!);
    }
    for (const p of today) {
      if (p.state !== 'REJECTED' && istDateKey(new Date(p.openedAt)) === this.day) this.ledger(brokerOfRecord(p)).orderTimes.push(p.openedAt);
    }
    for (const l of this.ledgers.values()) l.orderTimes.sort((a, b) => a - b);
  }

  /** Put a journaled position back under management. Its broker must already be registered. */
  restore(p: ManagedPosition): void {
    this.positions.set(p.id, p);
  }

  /** Today's realised P&L on the active broker. */
  get realisedPnl(): Paise { return this.ledger().realisedPnl; }
  get consecutiveLosses(): number { return this.ledger().consecutiveLosses; }
  get ordersToday(): number { return this.ledger().orderTimes.length; }
  get orderTimestamps(): readonly number[] { return this.ledger().orderTimes; }
  get rejectsLast5Min(): number {
    const cutoff = this.d.clock.ms() - REJECT_WINDOW_MS;
    return this.ledger().rejectTimes.filter((t) => t >= cutoff).length;
  }

  /** Open or pending positions — on one broker when given, else all of them (all are managed). */
  live(broker?: BrokerId): ManagedPosition[] {
    return [...this.positions.values()].filter((p) => LIVE_STATES.has(p.state) && (broker === undefined || p.broker === broker));
  }

  hasOrphan(): boolean {
    return [...this.positions.values()].some((p) => p.state === 'ORPHANED');
  }

  /** Open or pending in this instrument on the active broker — at most one at a time. */
  holds(instrumentKey: string, broker: BrokerId = this.active): boolean {
    return this.live(broker).some((p) => p.instrumentKey === instrumentKey);
  }

  /** Capital the active broker's open positions lock up. */
  deployed(broker: BrokerId = this.active): Paise {
    return this.live(broker).reduce((s, p) => s + p.costPaise, 0) as Paise;
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
      const broker = this.brokers.get(this.active)!;

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
        broker: this.active,
        costPaise: intent.costPaise,
        timeStopMin: intent.timeStopMin,
        ...(intent.stall ? { stall: intent.stall } : {}),
        trailingGap: intent.trailingGap,
        ...(intent.stagedTrail ? { stagedTrail: intent.stagedTrail } : {}),
        virtualStopPaise: null,
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
      // Nothing has reached a broker yet: if the journal refuses any of these
      // steps, drop the intent rather than place an order we could not recover.
      try {
        await m.transition(p, 'AI_REVIEWED');
        await m.transition(p, 'RISK_APPROVED');
        await m.transition(p, 'ENTRY_SENT');
      } catch (e) {
        this.positions.delete(p.id);
        return { ok: false, reason: `journal write failed, order not sent: ${e instanceof Error ? e.message : e}` };
      }
      this.ledger(p.broker).orderTimes.push(this.d.clock.ms());

      const r = await broker.placeBracketOrder({
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
          if (r.error.kind === 'REJECTED') this.ledger(p.broker).rejectTimes.push(this.d.clock.ms());
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
        this.log(`[TRADE OPEN] ${p.contract?.tradingSymbol ?? p.symbol} ${p.side} x${e.quantity} @ ₹${(e.avgPrice / 100).toFixed(2)} (${p.broker})`);
        return;
      }
      case 'ENTRY_FAILED': {
        if (p.state !== 'ENTRY_ACKED' && p.state !== 'ENTRY_SENT') return;
        p.exitReason = e.reason;
        await m.transition(p, 'CANCELLED');
        this.ledger(p.broker).rejectTimes.push(e.at);
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
    const l = this.ledger(p.broker);
    l.orderTimes.push(at);
    l.realisedPnl = (l.realisedPnl + pnl) as Paise;
    if (!isOperatorExit(p.exitReason)) l.consecutiveLosses = pnl < 0 ? l.consecutiveLosses + 1 : 0;
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
      const broker = this.brokerOf(p);
      if (!broker) return { ok: false, detail: `${p.broker} broker unavailable — exit ${p.symbol} at the broker directly` };
      const m = this.d.machine;

      if (p.state === 'ENTRY_ACKED' && p.gttOrderId) {
        const c = await broker.cancelBracket(p.gttOrderId);
        await broker.sync();
        return c.ok ? { ok: true, detail: 'pending entry cancelled' } : { ok: false, detail: c.error.message };
      }
      if (p.state !== 'MANAGING') return { ok: false, detail: `cannot exit from ${p.state}` };

      p.exitReason = reason;
      await m.transition(p, 'EXIT_TRIGGERED');
      if (p.gttOrderId) {
        const c = await broker.cancelBracket(p.gttOrderId);
        if (!c.ok) {
          await broker.sync();
          return { ok: true, detail: `bracket not cancellable (${c.error.message}); awaiting its fill` };
        }
      }
      const r = await broker.exitPosition({
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

  /**
   * Settle an ORPHANED position after a human checked the broker: either it is
   * gone (CLOSED, at the price they saw, if known) or it is held with a live
   * bracket (back to MANAGING). The engine never decides this on its own.
   */
  resolveOrphan(positionId: string, r: OrphanResolution): Promise<{ ok: boolean; detail: string }> {
    return this.serial(async () => {
      const p = this.positions.get(positionId);
      if (!p) return { ok: false, detail: 'position not found' };
      if (p.state !== 'ORPHANED') return { ok: false, detail: `position is ${p.state}, not ORPHANED` };
      const m = this.d.machine;

      if (r.kind === 'MANAGING') {
        if (p.filledQuantity <= 0 || p.avgEntry === null) return { ok: false, detail: 'no recorded fill — it can only be resolved as CLOSED' };
        p.exitReason = null;
        await m.transition(p, 'MANAGING');
        this.log(`[RESOLVED] ${p.symbol} back to MANAGING — ${r.note}`);
        return { ok: true, detail: 'position re-adopted' };
      }

      const now = this.d.clock.ms();
      const entry = p.avgEntry ?? p.entry;
      const pnl = r.exitPrice !== null && p.filledQuantity > 0
        ? ((p.side === 'BUY' ? r.exitPrice - entry : entry - r.exitPrice) * p.filledQuantity) as Paise
        : null;
      p.exitPrice = r.exitPrice;
      p.exitReason = `RESOLVED: ${r.note}`;
      p.realisedPnl = pnl;
      p.closedAt = now;
      if (pnl !== null) {
        this.rollDay();
        const l = this.ledger(p.broker);
        l.realisedPnl = (l.realisedPnl + pnl) as Paise;
      }
      await m.transition(p, 'CLOSED');
      this.log(`[RESOLVED] ${p.symbol} closed by operator — ${r.note}`);
      if (pnl !== null) this.d.onClosed?.(p);
      return { ok: true, detail: 'position closed' };
    });
  }

  /** Track how far a position went for and against us — the MAE/MFE of the trade log. */
  private excursion(p: ManagedPosition, price: number): void {
    if (p.avgEntry === null) return;
    const move = p.side === 'BUY' ? price - p.avgEntry : p.avgEntry - price;
    p.mfePaise = Math.max(p.mfePaise, move);
    p.maePaise = Math.min(p.maePaise, move);
  }

  /**
   * Kill switch: mark everything exiting, then let each broker flatten. The
   * active broker always runs its flatten — for Upstox that also catches
   * positions opened outside the engine.
   */
  flattenAll(): Promise<number> {
    return this.serial(async () => {
      for (const p of this.live()) {
        if (p.state === 'MANAGING') {
          p.exitReason = 'KILL_SWITCH';
          await this.d.machine.transition(p, 'EXIT_TRIGGERED');
        }
      }
      const ids = new Set<BrokerId>([this.active, ...this.live().map((p) => p.broker)]);
      let n = 0;
      for (const id of ids) {
        const b = this.brokers.get(id);
        if (!b) continue;
        const r = await b.exitAllPositions();
        await b.sync();
        if (r.ok) n += r.value;
      }
      return n;
    });
  }

  /**
   * Time-driven exits, run every second off a timer — not the tick stream, so a
   * dead feed cannot hold them up. Exits are risk-REDUCING, so they run even
   * when entry breakers are tripped. `eodOnly` keeps just the session-end
   * cancel and square-off, for when a breaker has stopped every other exit.
   */
  async manage(ltpOf: (key: string) => number | null, opts: { eodOnly?: boolean } = {}): Promise<void> {
    this.rollDay();
    const now = this.d.clock.ms();
    const mins = istMinutes(this.d.clock.now());
    const perTrade = this.d.perTradeLossPaise();

    for (const p of this.live()) {
      // An intraday position still open from an earlier session is overdue, not
      // "before 15:05" — square it off as soon as the market can price the exit.
      const overdue = istDateKey(new Date(p.openedAt)) !== this.day && mins >= SESSION.OPEN;
      const eod = p.product === 'I' && (mins >= SESSION.SQUARE_OFF || overdue);
      // Every unfilled entry goes at 15:00, whatever its product: one filling
      // minutes before the square-off is a trade with no runway.
      if (p.state === 'ENTRY_ACKED' && (mins >= SESSION.CANCEL_PENDING || eod)) {
        await this.exit(p.id, 'EOD_CANCEL');
        continue;
      }
      if (p.state !== 'MANAGING') continue;
      if (opts.eodOnly && !eod) continue;
      const ltp = ltpOf(p.instrumentKey);
      if (ltp !== null && ltp > 0) this.excursion(p, rupeesToPaise(ltp));

      if (eod) {
        await this.exit(p.id, 'EOD_SQUARE_OFF');
        continue;
      }

      // Cost-buffered breakeven & staged ATR trailing: waits for real follow-through
      // before tightening, keeping the exchange GTT as the fixed initial stop net.
      if (p.stagedTrail && ltp !== null && ltp > 0 && p.filledQuantity > 0) {
        const entry = p.avgEntry ?? p.entry;
        const initialRisk = Math.abs(p.entry - p.stopLoss);
        if (initialRisk > 0) {
          const long = p.side === 'BUY';
          const dir = long ? 1 : -1;
          const bestR = p.mfePaise / initialRisk;
          const bestPx = entry + dir * p.mfePaise;
          let candidate = p.virtualStopPaise ?? p.stopLoss;
          if (bestR >= p.stagedTrail.breakevenR) {
            const lockStop = Math.round(entry + dir * initialRisk * p.stagedTrail.breakevenLockR) as Paise;
            candidate = (long ? Math.max(candidate, lockStop) : Math.min(candidate, lockStop)) as Paise;
          }
          if (bestR >= p.stagedTrail.trailFromR && p.stagedTrail.trailGapPaise > 0) {
            const atrStop = Math.round(bestPx - dir * p.stagedTrail.trailGapPaise) as Paise;
            candidate = (long ? Math.max(candidate, atrStop) : Math.min(candidate, atrStop)) as Paise;
          }
          if (long ? candidate > p.stopLoss : candidate < p.stopLoss) {
            p.virtualStopPaise = candidate;
          }
          const ltpPx = rupeesToPaise(ltp);
          if (p.virtualStopPaise != null && (long ? ltpPx <= p.virtualStopPaise : ltpPx >= p.virtualStopPaise)) {
            await this.exit(p.id, 'TRAILING_STOP');
            continue;
          }
        }
      }
      const pnl = this.unrealised(p, ltp);
      // A backstop for a stop that failed — a gap through it, a bracket the
      // exchange dropped — not a second, tighter stop. At exactly the planned
      // risk it would race the bracket and exit early on an LTP tick at the
      // stop; a position sized before the capital fell is allowed its stop.
      const planned = Math.abs(p.entry - p.stopLoss) * p.filledQuantity;
      const limit = Math.max(perTrade, planned * STOP_SLIPPAGE_ALLOWANCE);
      if (perTrade > 0 && -pnl >= limit) {
        await this.exit(p.id, 'PER_TRADE_LOSS');
        continue;
      }
      if (p.timeStopMin !== null && p.filledAt !== null
        && now - p.filledAt >= p.timeStopMin * 60_000 && pnl <= 0) {
        await this.exit(p.id, 'TIME_STOP');
        continue;
      }
      const risk = Math.abs(p.entry - p.stopLoss);
      if (p.stall && p.filledAt !== null && risk > 0 && now - p.filledAt >= p.stall.afterMin * 60_000
        && p.mfePaise < p.stall.minMfeR * risk && pnl <= 0) {
        await this.exit(p.id, 'NO_FOLLOW_THROUGH');
      }
    }
  }
}

export type { PositionId };
