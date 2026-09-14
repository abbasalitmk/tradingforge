import type { Sql } from '@tradeforger/db';
import { audit } from '@tradeforger/db';

export type KillLevel = 'SOFT' | 'HARD' | 'NUCLEAR';

/**
 * Actions the kill switch needs from the broker. Injected rather than imported
 * so the switch can be tested without a live connection, and so it works
 * identically against the paper broker.
 */
export interface KillActions {
  stopNewEntries(): Promise<void>;
  cancelAllOpenOrders(): Promise<number>;
  cancelAllGtt(): Promise<number>;
  exitAllPositions(): Promise<number>;
  /** Disables the segment at Upstox account level. Survives our process being
   *  compromised, but re-enabling is subject to Upstox's own cooldown. */
  disableSegment(segment: string): Promise<void>;
}

export interface KillResult {
  readonly level: KillLevel;
  readonly ordersCancelled: number;
  readonly gttCancelled: number;
  readonly positionsExited: number;
  readonly segmentDisabled: boolean;
  readonly errors: readonly string[];
}

/**
 * Fire the kill switch.
 *
 * Every step is attempted even if an earlier one fails. A failure to cancel
 * GTTs must not prevent the attempt to flatten positions — partial success is
 * strictly better than aborting halfway through an emergency.
 */
export async function fire(
  level: KillLevel,
  actions: KillActions,
  sql: Sql,
  mode: string,
  actor: 'user' | 'watchdog' | 'engine' = 'user',
): Promise<KillResult> {
  const errors: string[] = [];
  let ordersCancelled = 0;
  let gttCancelled = 0;
  let positionsExited = 0;
  let segmentDisabled = false;

  const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await step('stopNewEntries', async () => actions.stopNewEntries());

  if (level === 'HARD' || level === 'NUCLEAR') {
    await step('cancelAllOpenOrders', async () => { ordersCancelled = await actions.cancelAllOpenOrders(); });
    await step('cancelAllGtt', async () => { gttCancelled = await actions.cancelAllGtt(); });
    await step('exitAllPositions', async () => { positionsExited = await actions.exitAllPositions(); });
  }

  if (level === 'NUCLEAR') {
    await step('disableSegment', async () => {
      await actions.disableSegment('NSE_EQ');
      segmentDisabled = true;
    });
  }

  const result: KillResult = { level, ordersCancelled, gttCancelled, positionsExited, segmentDisabled, errors };
  await audit(sql, {
    kind: 'KILL_SWITCH',
    actor,
    mode,
    payload: { ...result, errors: [...errors] },
  });
  return result;
}
