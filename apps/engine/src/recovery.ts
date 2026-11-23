import { istDateKey, type PositionState } from '@tradeforger/core';
import type { ManagedPosition } from './trader.ts';

/**
 * What to do with a journaled, non-terminal position when the engine starts.
 *
 *  DROP            — no order can exist: close the record out.
 *  ADOPT           — re-attach it to its broker exactly as it was.
 *  EXIT_NEXT_TICK  — paper only: finish an overdue or in-flight exit at the next price.
 *  ORPHAN          — the engine cannot know what the broker holds; a human must look.
 */
export type Recovery =
  | { readonly kind: 'DROP'; readonly to: 'REJECTED' | 'CANCELLED'; readonly reason: string }
  | { readonly kind: 'ADOPT' }
  | { readonly kind: 'EXIT_NEXT_TICK'; readonly reason: string }
  | { readonly kind: 'ORPHAN'; readonly reason: string };

/**
 * Live (Upstox) facts gathered at boot for a filled position, or null when they
 * could not be read (no trading token yet). Upstox's order book holds only
 * today's orders, so a bracket leg that fired on an earlier session is visible
 * only as a GTT rule pointing at an order the book no longer has.
 */
export interface UpstoxView {
  readonly gttFound: boolean;
  /** Exit-leg order ids the GTT reports but today's order book does not contain. */
  readonly exitOrdersOffBook: readonly string[];
}

const PRE_SEND: ReadonlySet<PositionState> = new Set(['CANDIDATE', 'AI_REVIEWED', 'RISK_APPROVED']);
const FILLED: ReadonlySet<PositionState> = new Set(['ENTRY_FILLED', 'BRACKET_ARMED', 'MANAGING']);

/**
 * Pure, so every restart rule is testable. Biased to ORPHAN whenever real money
 * might be involved and the facts are missing: an orphan halts entries until a
 * human confirms, which is cheap; managing a position that no longer exists —
 * or forgetting one that does — is not.
 */
export function planRecovery(p: ManagedPosition, today: string, view: UpstoxView | null): Recovery {
  if (p.state === 'ORPHANED') return { kind: 'ADOPT' };
  if (PRE_SEND.has(p.state)) return { kind: 'DROP', to: 'REJECTED', reason: 'engine restarted before the order was sent' };

  const openedDay = istDateKey(new Date(p.openedAt));
  const stale = openedDay !== today;

  if (p.broker === 'PAPER') {
    // The simulator's resting orders died with the process; an IMMEDIATE entry
    // that had not filled never will.
    if (p.state === 'ENTRY_SENT' || p.state === 'ENTRY_ACKED') {
      return { kind: 'DROP', to: 'CANCELLED', reason: 'paper entry lost in engine restart' };
    }
    if (p.state === 'EXIT_TRIGGERED' || p.state === 'EXIT_FILLED') {
      return { kind: 'EXIT_NEXT_TICK', reason: p.exitReason ?? 'exit in flight at restart' };
    }
    if (p.product === 'I' && stale) return { kind: 'EXIT_NEXT_TICK', reason: `EOD_SQUARE_OFF (overdue from ${openedDay})` };
    return { kind: 'ADOPT' };
  }

  // ── UPSTOX: real money. Adopt only what the broker's own records can confirm.
  if (p.state === 'ENTRY_SENT' || p.gttOrderId === null) {
    return { kind: 'ORPHAN', reason: 'placement outcome unknown at restart — check the Upstox GTT list and order book' };
  }
  if (p.state === 'EXIT_TRIGGERED' || p.state === 'EXIT_FILLED') {
    return { kind: 'ORPHAN', reason: 'an exit was in flight at restart — confirm at Upstox whether the position is still held' };
  }
  if (p.product === 'I' && stale) {
    return { kind: 'ORPHAN', reason: `intraday position from ${openedDay} — Upstox squares off MIS at the close; confirm the exit price and resolve` };
  }
  if (p.state === 'ENTRY_ACKED' && stale) {
    return { kind: 'ORPHAN', reason: `entry acknowledged on ${openedDay}, fill not visible in today's order book — confirm at Upstox` };
  }
  if (view) {
    if (!view.gttFound) return { kind: 'ORPHAN', reason: `bracket GTT ${p.gttOrderId} no longer exists at Upstox — the position may be unprotected` };
    if (FILLED.has(p.state) && view.exitOrdersOffBook.length > 0) {
      return { kind: 'ORPHAN', reason: `bracket leg fired while the engine was offline (order ${view.exitOrdersOffBook.join(', ')}) — confirm the exit price and resolve` };
    }
  }
  // Unverified (no token yet) positions are adopted and re-verified at login.
  return { kind: 'ADOPT' };
}
