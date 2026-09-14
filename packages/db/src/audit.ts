import type { Sql } from './client.ts';

/**
 * Audit event kinds. This is the complete vocabulary of things the system can
 * record; adding a kind is a deliberate act, not an ad-hoc string.
 */
export type AuditKind =
  | 'ENGINE_BOOT' | 'ENGINE_SHUTDOWN' | 'PREFLIGHT_PASS' | 'PREFLIGHT_FAIL'
  | 'MODE_CHANGE' | 'ARM' | 'DISARM'
  | 'SIGNAL_GENERATED' | 'AI_REQUEST' | 'AI_RESPONSE' | 'AI_FALLBACK'
  | 'RISK_APPROVED' | 'RISK_REJECTED' | 'SIZING'
  | 'ORDER_REQUEST' | 'ORDER_ACK' | 'ORDER_REJECT' | 'ORDER_FILL'
  | 'GTT_PLACED' | 'GTT_MODIFIED' | 'GTT_CANCELLED'
  | 'STATE_TRANSITION' | 'POSITION_CLOSED'
  | 'BREAKER_TRIP' | 'BREAKER_RESET' | 'HALT' | 'RESUME'
  | 'KILL_SWITCH' | 'WATCHDOG_FIRE'
  | 'WEBHOOK_HINT' | 'RECONCILE' | 'DIVERGENCE'
  | 'TOKEN_REFRESH' | 'TOKEN_INVALID';

export type Actor = 'engine' | 'user' | 'webhook' | 'watchdog' | 'scheduler';

/** JSON-safe payload shape, matching what postgres.js will accept. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

export interface AuditEntry {
  kind: AuditKind;
  actor: Actor;
  mode: string;
  positionId?: string | undefined;
  signalId?: string | undefined;
  payload: JsonObject;
}

/**
 * Append to the tamper-evident log.
 *
 * Never throws: an audit write must not be able to abort a trade decision that
 * is already in flight, and a lost log line is strictly less bad than an
 * unmanaged position. Failures are surfaced on stderr and counted by the caller
 * via the returned boolean.
 */
export async function audit(sql: Sql, e: AuditEntry): Promise<boolean> {
  try {
    await sql`
      INSERT INTO audit_log (kind, actor, mode, position_id, signal_id, payload)
      VALUES (${e.kind}, ${e.actor}, ${e.mode},
              ${e.positionId ?? null}, ${e.signalId ?? null},
              ${sql.json(e.payload)})`;
    return true;
  } catch (err) {
    console.error('[audit] write failed', { kind: e.kind, err });
    return false;
  }
}

export interface ChainStatus {
  ok: boolean;
  checked: number;
  brokenAt: number | null;
}

/** Verify the hash chain end to end. Run at boot and before promoting to LIVE. */
export async function verifyChain(sql: Sql): Promise<ChainStatus> {
  const [row] = await sql<{ ok: boolean; checked: number; broken_at: number | null }[]>`
    SELECT * FROM verify_audit_chain()`;
  return {
    ok: row?.ok ?? true,
    checked: Number(row?.checked ?? 0),
    brokenAt: row?.broken_at ?? null,
  };
}
