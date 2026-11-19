import { paiseToRupees } from '@tradeforger/core';
import type { Sql } from '@tradeforger/db';
import {
  roundTripCost, computeMetrics, EQUITY_INTRADAY, EQUITY_DELIVERY, FNO_OPTIONS, FNO_FUTURES,
  type CostModel, type Metrics, type TradeRecord,
} from '@tradeforger/backtest';
import type { ManagedPosition } from './trader.ts';

export interface TradeLogEntry {
  positionId: string;
  strategyId: string | null;
  strategyVersion: string | null;
  mode: string;
  segment: 'EQ' | 'FO';
  style: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryTime: number | null;
  entryPrice: number | null;
  plannedEntry: number;
  stopLoss: number;
  target: number;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  slippage: number | null;
  charges: number;
  grossPnl: number;
  netPnl: number;
  rMultiple: number | null;
  maeR: number | null;
  mfeR: number | null;
  quality: number | null;
}

function costModel(p: ManagedPosition): CostModel {
  if (p.segment === 'FO') return p.contract?.instrumentType === 'FUT' ? FNO_FUTURES : FNO_OPTIONS;
  return p.product === 'I' ? EQUITY_INTRADAY : EQUITY_DELIVERY;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Every closed trade, with why it was taken and how it behaved.
 *
 * Win/loss alone teaches nothing; MAE/MFE says whether stops are too tight or
 * targets too far, slippage says whether paper fills were honest, and the
 * strategy version ties each outcome back to the parameters that produced it.
 * Writes never throw: losing a log line must not disturb the trading loop.
 */
export class TradeMemory {
  private readonly sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  entryFor(p: ManagedPosition, mode: string): TradeLogEntry {
    const entry = p.avgEntry ?? p.entry;
    const exit = p.exitPrice ?? entry;
    const qty = p.filledQuantity;
    const risk = Math.abs(p.entry - p.stopLoss); // planned per-unit risk, paise
    const gross = paiseToRupees(p.realisedPnl ?? (0 as never));
    const charges = qty > 0 ? roundTripCost(costModel(p), p.side, qty, paiseToRupees(entry), paiseToRupees(exit)) : 0;
    const net = gross - charges;
    const rDenom = paiseToRupees(risk as never) * qty;
    return {
      positionId: p.id,
      strategyId: p.strategyId ?? null,
      strategyVersion: p.strategyVersion ?? null,
      mode,
      segment: p.segment,
      style: p.style,
      symbol: p.contract?.tradingSymbol ?? p.symbol,
      side: p.side,
      quantity: qty,
      entryTime: p.filledAt,
      entryPrice: p.avgEntry !== null ? paiseToRupees(p.avgEntry) : null,
      plannedEntry: paiseToRupees(p.entry),
      stopLoss: paiseToRupees(p.stopLoss),
      target: paiseToRupees(p.target),
      exitTime: p.closedAt,
      exitPrice: p.exitPrice !== null ? paiseToRupees(p.exitPrice) : null,
      exitReason: p.exitReason,
      // Positive = we paid more (BUY) / received less (SELL) than planned.
      slippage: p.avgEntry !== null ? paiseToRupees(((p.side === 'BUY' ? 1 : -1) * (p.avgEntry - p.entry)) as never) : null,
      charges,
      grossPnl: gross,
      netPnl: net,
      rMultiple: rDenom > 0 ? net / rDenom : null,
      maeR: risk > 0 ? p.maePaise / risk : null,
      mfeR: risk > 0 ? p.mfePaise / risk : null,
      quality: p.quality ?? null,
    };
  }

  async record(p: ManagedPosition, mode: string): Promise<void> {
    // Rejected / cancelled entries never held anything; nothing to learn from.
    if (p.filledQuantity <= 0) return;
    const e = this.entryFor(p, mode);
    try {
      await this.sql`
        INSERT INTO trade_log (
          position_id, strategy_id, strategy_version, mode, segment, style, symbol, instrument_key,
          side, quantity, entry_time, entry_price, planned_entry, stop_loss, target, exit_time,
          exit_price, exit_reason, slippage, charges, gross_pnl, net_pnl, r_multiple, mae_r, mfe_r,
          quality, metadata
        ) VALUES (
          ${e.positionId}, ${e.strategyId}, ${e.strategyVersion}, ${e.mode}, ${e.segment}, ${e.style},
          ${e.symbol}, ${p.instrumentKey}, ${e.side}, ${e.quantity},
          ${e.entryTime !== null ? new Date(e.entryTime) : null}, ${e.entryPrice}, ${e.plannedEntry},
          ${e.stopLoss}, ${e.target}, ${e.exitTime !== null ? new Date(e.exitTime) : null}, ${e.exitPrice},
          ${e.exitReason}, ${e.slippage}, ${e.charges}, ${e.grossPnl}, ${e.netPnl}, ${e.rMultiple},
          ${e.maeR}, ${e.mfeR}, ${e.quality},
          ${this.sql.json({ underlying: p.underlyingSymbol ?? null, contract: (p.contract ?? null) as never, product: p.product })}
        ) ON CONFLICT (position_id) DO NOTHING`;
    } catch (err) {
      console.error('[trade memory] write failed', err instanceof Error ? err.message : err);
    }
  }

  async recent(limit = 100): Promise<TradeLogEntry[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM trade_log ORDER BY exit_time DESC NULLS LAST LIMIT ${limit}`;
    return rows.map((r) => ({
      positionId: String(r['position_id']),
      strategyId: (r['strategy_id'] as string | null) ?? null,
      strategyVersion: (r['strategy_version'] as string | null) ?? null,
      mode: String(r['mode']),
      segment: r['segment'] as 'EQ' | 'FO',
      style: String(r['style']),
      symbol: String(r['symbol']),
      side: r['side'] as 'BUY' | 'SELL',
      quantity: Number(r['quantity']),
      entryTime: r['entry_time'] instanceof Date ? r['entry_time'].getTime() : null,
      entryPrice: num(r['entry_price']),
      plannedEntry: Number(r['planned_entry']),
      stopLoss: Number(r['stop_loss']),
      target: Number(r['target']),
      exitTime: r['exit_time'] instanceof Date ? r['exit_time'].getTime() : null,
      exitPrice: num(r['exit_price']),
      exitReason: (r['exit_reason'] as string | null) ?? null,
      slippage: num(r['slippage']),
      charges: Number(r['charges'] ?? 0),
      grossPnl: Number(r['gross_pnl'] ?? 0),
      netPnl: Number(r['net_pnl'] ?? 0),
      rMultiple: num(r['r_multiple']),
      maeR: num(r['mae_r']),
      mfeR: num(r['mfe_r']),
      quality: num(r['quality']),
    }));
  }

  /** Live/paper performance per strategy, on the same metrics the backtester reports. */
  async summary(capital: number, limit = 1000): Promise<Array<{ strategyId: string; mode: string; metrics: Metrics }>> {
    const trades = await this.recent(limit);
    const groups = new Map<string, TradeLogEntry[]>();
    for (const t of trades) {
      const k = `${t.strategyId ?? 'UNKNOWN'}|${t.mode}`;
      groups.set(k, [...(groups.get(k) ?? []), t]);
    }
    return [...groups].map(([k, list]) => {
      const [strategyId, mode] = k.split('|') as [string, string];
      const records: TradeRecord[] = list
        .filter((t) => t.entryTime !== null && t.exitTime !== null && t.entryPrice !== null && t.exitPrice !== null)
        .map((t) => ({
          strategyId, symbol: t.symbol, side: t.side,
          entryTs: t.entryTime!, entryPrice: t.entryPrice!, exitTs: t.exitTime!, exitPrice: t.exitPrice!,
          qty: t.quantity, grossPnl: t.grossPnl, costs: t.charges, netPnl: t.netPnl,
          rMultiple: t.rMultiple ?? 0, maeR: t.maeR ?? 0, mfeR: t.mfeR ?? 0,
          exitReason: (t.exitReason === 'TARGET' || t.exitReason === 'STOPLOSS' ? t.exitReason : 'EOD') as TradeRecord['exitReason'],
          barsHeld: 0,
        }))
        .sort((a, b) => a.entryTs - b.entryTs);
      return { strategyId, mode, metrics: computeMetrics(records, capital) };
    });
  }
}
