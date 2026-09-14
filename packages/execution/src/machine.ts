import {
  type PositionState, type Side, type Paise, type PositionId,
  canTransition, isTerminal,
} from '@tradeforger/core';

export interface PositionRecord {
  readonly id: PositionId;
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly side: Side;
  state: PositionState;
  quantity: number;
  filledQuantity: number;
  entry: Paise;
  avgEntry: Paise | null;
  stopLoss: Paise;
  target: Paise;
  entryOrderId: string | null;
  gttOrderId: string | null;
  openedAt: number;
}

export class TransitionError extends Error {
  readonly from: PositionState;
  readonly to: PositionState;

  constructor(from: PositionState, to: PositionState) {
    super(`illegal transition ${from} → ${to}`);
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
  }
}

export type TransitionHook = (
  p: PositionRecord,
  from: PositionState,
  to: PositionState,
) => Promise<void>;

/**
 * Position state machine.
 *
 * Two rules make this trustworthy:
 *
 *  1. Illegal transitions THROW rather than being tolerated. A position that
 *     jumps from ENTRY_SENT straight to MANAGING means we lost track of a fill,
 *     and quietly accepting it would hide the bug that costs money.
 *
 *  2. The persist hook runs BEFORE the in-memory state changes. If persistence
 *     fails, the transition does not happen — so the journal can never be
 *     behind reality, only ahead of it. Recovering from "we recorded an intent
 *     we never executed" is tractable; recovering from "we executed something
 *     we never recorded" is not.
 */
export class PositionMachine {
  private readonly onTransition: TransitionHook;

  constructor(onTransition: TransitionHook) {
    this.onTransition = onTransition;
  }

  async transition(p: PositionRecord, to: PositionState): Promise<void> {
    const from = p.state;
    if (from === to) return;
    if (!canTransition(from, to)) throw new TransitionError(from, to);

    await this.onTransition(p, from, to);
    p.state = to;
  }

  /**
   * Force a position into ORPHANED.
   *
   * Bypasses the transition table deliberately: ORPHANED means "open position
   * with no live bracket", which is reachable from any state via a failure, and
   * refusing the transition on a technicality would leave the position both
   * unprotected and unflagged.
   */
  async orphan(p: PositionRecord, reason: string): Promise<void> {
    const from = p.state;
    if (from === 'ORPHANED' || isTerminal(from)) return;
    await this.onTransition(p, from, 'ORPHANED');
    p.state = 'ORPHANED';
    console.error(`[ORPHANED] ${p.id} ${p.symbol}: ${reason}`);
  }
}

/** Positions that still need managing after a restart. */
export const isActive = (s: PositionState): boolean =>
  !isTerminal(s) && s !== 'CANDIDATE' && s !== 'AI_REVIEWED';

/** Position exists at the broker but we hold no live bracket for it. */
export function detectOrphan(p: PositionRecord, liveGttIds: ReadonlySet<string>): boolean {
  const holdsShares = p.filledQuantity > 0;
  if (!holdsShares) return false;
  if (p.state === 'ENTRY_FILLED') return true; // bracket not armed yet
  if (p.gttOrderId === null) return true;
  return !liveGttIds.has(p.gttOrderId);
}
