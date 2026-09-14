import { type Clock, type Paise, istMinutes, istDateKey, SESSION, pctOf } from '@tradeforger/core';
import type { Limits } from './limits.ts';

export type BreakerId =
  | 'DAILY_LOSS' | 'PER_TRADE_LOSS' | 'CONSECUTIVE_LOSSES'
  | 'MAX_POSITIONS' | 'ORDERS_PER_DAY' | 'ORDERS_PER_MINUTE'
  | 'REJECT_RATE' | 'FEED_STALE' | 'DIVERGENCE' | 'MARGIN'
  | 'OUTSIDE_WINDOW' | 'MAINTENANCE_WINDOW' | 'MANUAL_HALT';

export interface Trip {
  readonly id: BreakerId;
  readonly detail: string;
  /** Whether open positions may still be exited while this breaker is tripped.
   *  Almost always true — halting exits would strand real money. */
  readonly allowExits: boolean;
}

/** Observable state the breakers evaluate against. Supplied by the engine. */
export interface RiskSnapshot {
  readonly startingCapitalPaise: Paise;
  readonly realisedPnlPaise: Paise;
  readonly unrealisedPnlPaise: Paise;
  readonly openPositions: number;
  readonly ordersToday: number;
  readonly consecutiveLosses: number;
  readonly rejectsLast5Min: number;
  readonly orderTimestamps: readonly number[];
  readonly lastTickMs: number | null;
  readonly marginUtilisationPct: number;
  readonly divergenceDetected: boolean;
  readonly manualHalt: boolean;
  /** Worst open position's unrealised loss, as a positive number. */
  readonly worstOpenLossPaise: Paise;
}

export interface Verdict {
  readonly allowEntries: boolean;
  readonly allowExits: boolean;
  readonly trips: readonly Trip[];
}

/**
 * Evaluate every circuit breaker.
 *
 * Deliberately pure and synchronous: no I/O, no clock reads beyond the injected
 * Clock, no hidden state. That makes the entire risk posture of the system
 * testable as a table of inputs, which is the only way to have confidence in
 * code whose failure mode is losing money.
 *
 * Exits stay permitted under nearly every trip. A breaker that blocked exits
 * would convert a bad day into an unbounded one.
 */
export function evaluate(snap: RiskSnapshot, limits: Limits, clock: Clock): Verdict {
  const trips: Trip[] = [];
  const now = clock.now();
  const mins = istMinutes(now);

  if (snap.manualHalt) {
    trips.push({ id: 'MANUAL_HALT', detail: 'halted by operator', allowExits: true });
  }

  // Daily loss uses realised + unrealised. Using realised alone would let a
  // large open loser sail past the limit until it is closed.
  const totalPnl = snap.realisedPnlPaise + snap.unrealisedPnlPaise;
  const dailyLossLimit = pctOf(snap.startingCapitalPaise, limits.dailyLossPct);
  if (totalPnl < 0 && Math.abs(totalPnl) >= dailyLossLimit) {
    trips.push({
      id: 'DAILY_LOSS',
      detail: `P&L ${totalPnl} paise breached limit ${dailyLossLimit}`,
      allowExits: true,
    });
  }

  const perTradeLimit = pctOf(snap.startingCapitalPaise, limits.perTradeLossPct);
  if (snap.worstOpenLossPaise >= perTradeLimit) {
    trips.push({
      id: 'PER_TRADE_LOSS',
      detail: `open loss ${snap.worstOpenLossPaise} breached ${perTradeLimit}`,
      allowExits: true,
    });
  }

  if (snap.consecutiveLosses >= limits.maxConsecutiveLosses) {
    trips.push({
      id: 'CONSECUTIVE_LOSSES',
      detail: `${snap.consecutiveLosses} consecutive losses`,
      allowExits: true,
    });
  }

  if (snap.openPositions >= limits.maxConcurrentPositions) {
    trips.push({
      id: 'MAX_POSITIONS',
      detail: `${snap.openPositions} open, cap ${limits.maxConcurrentPositions}`,
      allowExits: true,
    });
  }

  if (snap.ordersToday >= limits.maxOrdersPerDay) {
    trips.push({
      id: 'ORDERS_PER_DAY',
      detail: `${snap.ordersToday} orders today`,
      allowExits: true,
    });
  }

  // Runaway-loop guard. The Upstox rate limit is 10/sec — without this a
  // looping bug burns the daily loss limit in seconds.
  const cutoff = clock.ms() - 60_000;
  const lastMinute = snap.orderTimestamps.filter((t) => t >= cutoff).length;
  if (lastMinute >= limits.maxOrdersPerMinute) {
    trips.push({
      id: 'ORDERS_PER_MINUTE',
      detail: `${lastMinute} orders in last minute`,
      allowExits: true,
    });
  }

  if (snap.rejectsLast5Min >= limits.maxRejectsIn5Min) {
    trips.push({
      id: 'REJECT_RATE',
      detail: `${snap.rejectsLast5Min} rejects in 5 min`,
      allowExits: true,
    });
  }

  // Staleness only matters while the market is open; a quiet feed at 20:00 is
  // correct behaviour, not a fault.
  const marketOpen = mins >= SESSION.OPEN && mins < SESSION.CLOSE;
  if (marketOpen) {
    const age = snap.lastTickMs === null ? Infinity : clock.ms() - snap.lastTickMs;
    if (age >= limits.feedStalenessMs) {
      trips.push({
        id: 'FEED_STALE',
        detail: snap.lastTickMs === null ? 'no ticks received' : `last tick ${Math.round(age)}ms ago`,
        allowExits: true,
      });
    }
  }

  // Engine and broker disagree about reality. The only safe response is to stop
  // acting on our own view and let a human look.
  if (snap.divergenceDetected) {
    trips.push({ id: 'DIVERGENCE', detail: 'engine/broker state mismatch', allowExits: false });
  }

  if (snap.marginUtilisationPct >= limits.maxMarginUtilisationPct) {
    trips.push({
      id: 'MARGIN',
      detail: `margin at ${snap.marginUtilisationPct}%`,
      allowExits: true,
    });
  }

  if (mins >= SESSION.MAINTENANCE_START && mins < SESSION.MAINTENANCE_END) {
    trips.push({ id: 'MAINTENANCE_WINDOW', detail: 'Upstox maintenance 00:00-05:30 IST', allowExits: false });
  }

  if (mins < SESSION.ENTRY_START || mins >= SESSION.ENTRY_END) {
    trips.push({ id: 'OUTSIDE_WINDOW', detail: `IST ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')} outside entry window`, allowExits: true });
  }

  return {
    allowEntries: trips.length === 0,
    allowExits: trips.every((t) => t.allowExits),
    trips,
  };
}

/** Intraday positions must be flat before the exchange squares them off for us. */
export function mustSquareOff(clock: Clock): boolean {
  return istMinutes(clock.now()) >= SESSION.SQUARE_OFF;
}

export const tradeDateKey = (clock: Clock): string => istDateKey(clock.now());
