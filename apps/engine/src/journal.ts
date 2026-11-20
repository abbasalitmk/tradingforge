import type { Mode, PositionState, SizingMode } from '@tradeforger/core';
import type { Sql } from '@tradeforger/db';
import type { BrokerId } from '@tradeforger/broker';
import type { ManagedPosition } from './trader.ts';

const TERMINAL = ['CLOSED', 'REJECTED', 'CANCELLED'];
const ts = (ms: number | null): Date | null => (ms === null ? null : new Date(ms));

/**
 * Durable record of every position, written on each state transition.
 *
 * The in-memory Trader is fast; this is what survives a container restart. A
 * write carries the whole managed record, so it is idempotent — a write that
 * failed can simply be retried with the position's current state.
 */
export class PositionStore {
  private readonly sql: Sql;
  private readonly ctx: () => { mode: Mode; sizingMode: SizingMode };

  constructor(sql: Sql, ctx: () => { mode: Mode; sizingMode: SizingMode }) {
    this.sql = sql;
    this.ctx = ctx;
  }

  /** Upsert `p` as being in `state`. Throws on failure — the caller decides whether that is fatal. */
  async save(p: ManagedPosition, state: PositionState): Promise<void> {
    const { mode, sizingMode } = this.ctx();
    const snapshot = JSON.parse(JSON.stringify({ ...p, state }));
    await this.sql`
      INSERT INTO positions (
        id, instrument_key, symbol, side, style, state, mode, sizing_mode,
        quantity, filled_quantity, entry_paise, avg_entry_paise, stop_loss_paise, target_paise, exit_paise,
        entry_order_id, gtt_order_id, broker_tag, realised_pnl_paise, opened_at, closed_at, broker, snapshot
      ) VALUES (
        ${p.id}, ${p.instrumentKey}, ${p.symbol}, ${p.side}, ${p.style}, ${state}, ${mode}, ${sizingMode},
        ${p.quantity}, ${p.filledQuantity}, ${p.entry}, ${p.avgEntry}, ${p.stopLoss}, ${p.target}, ${p.exitPrice},
        ${p.entryOrderId}, ${p.gttOrderId}, ${p.id}, ${p.realisedPnl}, ${new Date(p.openedAt)}, ${ts(p.closedAt)},
        ${p.broker}, ${this.sql.json(snapshot)}
      )
      ON CONFLICT (id) DO UPDATE SET
        state = EXCLUDED.state,
        filled_quantity = EXCLUDED.filled_quantity,
        avg_entry_paise = EXCLUDED.avg_entry_paise,
        stop_loss_paise = EXCLUDED.stop_loss_paise,
        target_paise = EXCLUDED.target_paise,
        exit_paise = EXCLUDED.exit_paise,
        gtt_order_id = EXCLUDED.gtt_order_id,
        realised_pnl_paise = EXCLUDED.realised_pnl_paise,
        closed_at = EXCLUDED.closed_at,
        snapshot = EXCLUDED.snapshot,
        updated_at = now()`;
  }

  /** Every position the engine must still manage or account for. */
  async loadOpen(): Promise<ManagedPosition[]> {
    const rows = await this.sql<{ state: PositionState; broker: BrokerId; snapshot: ManagedPosition }[]>`
      SELECT state, broker, snapshot FROM positions
      WHERE state NOT IN ${this.sql(TERMINAL)}
      ORDER BY opened_at`;
    return rows.map((r) => ({ ...r.snapshot, state: r.state, broker: r.broker }));
  }

  /** Positions opened or closed since `sinceMs` — the inputs to today's risk counters. */
  async loadSince(sinceMs: number): Promise<ManagedPosition[]> {
    const since = new Date(sinceMs);
    const rows = await this.sql<{ state: PositionState; broker: BrokerId; snapshot: ManagedPosition }[]>`
      SELECT state, broker, snapshot FROM positions
      WHERE opened_at >= ${since} OR closed_at >= ${since}`;
    return rows.map((r) => ({ ...r.snapshot, state: r.state, broker: r.broker }));
  }
}

/** Small JSON settings in `engine_state`: dashboard choices that must survive a restart. */
export class EngineStateStore {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async get<T>(key: string): Promise<T | null> {
    const [row] = await this.sql<{ value: T }[]>`SELECT value FROM engine_state WHERE key = ${key}`;
    return row?.value ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.sql`
      INSERT INTO engine_state (key, value) VALUES (${key}, ${this.sql.json(JSON.parse(JSON.stringify(value)))})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  }
}
