import { type Mode, MODE_RANK, placesRealOrders, type Clock, istMinutes, SESSION } from '@tradeforger/core';

export interface ArmState {
  readonly mode: Mode;
  /** LIVE requires an explicit per-session arm that expires at 15:30 IST. */
  readonly armedUntilMs: number | null;
  readonly armedBy: string | null;
}

export type ModeDenial =
  | { reason: 'LIVE_TRADING_FLAG_OFF' }
  | { reason: 'NOT_ARMED' }
  | { reason: 'ARM_EXPIRED'; expiredAtMs: number }
  | { reason: 'CONFIRMATION_MISMATCH' };

/**
 * Guards the transition into LIVE.
 *
 * Four independent things must be true. They are independent on purpose — no
 * single mistake, env var, or stray click reaches real money.
 */
export function canEnterLive(
  env: { LIVE_TRADING: string | undefined },
  confirmation: string,
  expectedConfirmation: string,
): { ok: true } | { ok: false; denial: ModeDenial } {
  if (env.LIVE_TRADING !== 'true') return { ok: false, denial: { reason: 'LIVE_TRADING_FLAG_OFF' } };
  if (confirmation !== expectedConfirmation) {
    return { ok: false, denial: { reason: 'CONFIRMATION_MISMATCH' } };
  }
  return { ok: true };
}

/** Arms LIVE until the close of the current session — never open-ended. */
export function armUntilSessionEnd(clock: Clock, by: string): ArmState {
  const now = clock.now();
  const mins = istMinutes(now);
  const remaining = Math.max(0, SESSION.CLOSE - mins);
  return {
    mode: 'LIVE',
    armedUntilMs: clock.ms() + remaining * 60_000,
    armedBy: by,
  };
}

/**
 * The effective mode right now.
 *
 * An expired arm silently degrades to LIVE_ARMED rather than staying LIVE, so
 * forgetting to disarm cannot leave the system live overnight.
 */
export function effectiveMode(state: ArmState, clock: Clock): Mode {
  if (state.mode !== 'LIVE') return state.mode;
  if (state.armedUntilMs === null || clock.ms() >= state.armedUntilMs) return 'LIVE_ARMED';
  return 'LIVE';
}

/** Downgrades are always permitted; upgrades never happen implicitly. */
export function isDowngrade(from: Mode, to: Mode): boolean {
  return MODE_RANK[to] < MODE_RANK[from];
}

export { placesRealOrders };
