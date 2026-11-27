import { paiseToRupees } from '@tradeforger/core';
import type { Sql } from '@tradeforger/db';
import {
  roundTripCost, computeMetrics, EQUITY_INTRADAY, EQUITY_DELIVERY, FNO_OPTIONS, FNO_FUTURES,
  type CostModel, type Metrics, type TradeRecord,
} from '@tradeforger/backtest';
import type { ManagedPosition } from './trader.ts';

export type TradeFinding =
  | 'CLEAN_TARGET_HIT'
  | 'CLEAN_WIN'
  | 'TARGET_TOO_FAR'
  | 'PROFIT_GAVE_BACK'
  | 'GROSS_WIN_NET_LOSS'
  | 'HIGH_COST_DRAG'
  | 'POOR_ENTRY_FOLLOWTHROUGH'
  | 'CLEAN_STOPOUT'
  | 'EOD_EXIT';

export interface ClosedTradeAnalysis {
  readonly verdict: 'WIN' | 'SCRATCH' | 'LOSS';
  /** True only when the trade actually made meaningful positive money after all charges and slippage. */
  readonly successful: boolean;
  readonly holdMinutes: number | null;
  readonly plannedRiskRs: number;
  readonly plannedRR: number;
  readonly entrySlippagePct: number;
  readonly costDragPct: number;
  /** Fraction of peak favourable excursion actually banked (`rMultiple / mfeR`). */
  readonly captureRatio: number | null;
  /** Peak favourable move as % of planned target distance. */
  readonly targetReachedPct: number | null;
  readonly findings: readonly TradeFinding[];
  readonly diagnosis: string;
}

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
  analysis?: ClosedTradeAnalysis;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Deep post-close trade analysis: checks net profitability, execution slippage,
 * cost drag relative to 1R risk, MFE capture efficiency, and target realism.
 */
export function analyzeClosedTrade(e: TradeLogEntry): ClosedTradeAnalysis {
  const unitRisk = Math.abs(e.plannedEntry - e.stopLoss);
  const unitReward = Math.abs(e.target - e.plannedEntry);
  const plannedRiskRs = r2(unitRisk * e.quantity);
  const plannedRR = unitRisk > 0 ? r2(unitReward / unitRisk) : 0;
  const r = e.rMultiple ?? 0;
  const verdict: ClosedTradeAnalysis['verdict'] = e.netPnl > 0 && r >= 0.15
    ? 'WIN'
    : e.grossPnl > 0 && e.netPnl <= 0
      ? 'SCRATCH'
      : Math.abs(r) < 0.15
        ? 'SCRATCH'
        : 'LOSS';
  const successful = verdict === 'WIN';
  const holdMinutes = e.entryTime !== null && e.exitTime !== null && e.exitTime >= e.entryTime
    ? Math.round((e.exitTime - e.entryTime) / 60_000)
    : null;
  const entrySlippagePct = e.plannedEntry > 0 && e.slippage !== null
    ? Math.round((e.slippage / e.plannedEntry) * 10_000) / 100
    : 0;
  const costDragPct = plannedRiskRs > 0 ? Math.round((e.charges / plannedRiskRs) * 1000) / 10 : 0;
  const mfe = e.mfeR;
  const mae = e.maeR;
  const captureRatio = mfe !== null && mfe > 0.15 && e.rMultiple !== null ? r2(e.rMultiple / mfe) : null;
  const targetReachedPct = plannedRR > 0 && mfe !== null ? Math.round((mfe / plannedRR) * 100) : null;

  const findings: TradeFinding[] = [];
  if (e.exitReason === 'TARGET' && successful) findings.push('CLEAN_TARGET_HIT');
  else if (successful) findings.push('CLEAN_WIN');

  if (e.exitReason !== 'TARGET' && targetReachedPct !== null && targetReachedPct >= 60) {
    findings.push('TARGET_TOO_FAR');
  }
  if (mfe !== null && mfe >= 1.0 && r < mfe * 0.45) {
    findings.push('PROFIT_GAVE_BACK');
  }
  if (e.grossPnl > 0 && e.netPnl <= 0) findings.push('GROSS_WIN_NET_LOSS');
  if (costDragPct >= 25) findings.push('HIGH_COST_DRAG');
  if (mae !== null && mae <= -0.65 && (mfe === null || mfe < 0.3)) {
    findings.push('POOR_ENTRY_FOLLOWTHROUGH');
  }
  if (e.exitReason === 'STOPLOSS' && !successful && findings.length === 0) findings.push('CLEAN_STOPOUT');
  if (e.exitReason === 'EOD_SQUARE_OFF' && !findings.length) findings.push('EOD_EXIT');

  const notes: string[] = [];
  if (findings.includes('TARGET_TOO_FAR')) notes.push(`reached ${targetReachedPct}% of ${plannedRR}R target without filling`);
  if (findings.includes('PROFIT_GAVE_BACK')) notes.push(`peaked at +${mfe?.toFixed(2)}R MFE, exited at ${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
  if (findings.includes('GROSS_WIN_NET_LOSS')) notes.push(`gross +₹${e.grossPnl.toFixed(0)} erased by ₹${e.charges.toFixed(0)} charges`);
  if (findings.includes('HIGH_COST_DRAG')) notes.push(`charges ate ${costDragPct.toFixed(0)}% of 1R risk`);
  if (findings.includes('POOR_ENTRY_FOLLOWTHROUGH')) notes.push(`adverse ${mae?.toFixed(2)}R immediately after entry`);
  if (notes.length === 0) {
    notes.push(successful
      ? `${e.exitReason ?? 'closed'} at +${r.toFixed(2)}R${mfe !== null ? ` (MFE +${mfe.toFixed(2)}R)` : ''}`
      : `${e.exitReason ?? 'closed'} at ${r.toFixed(2)}R`);
  }

  return {
    verdict,
    successful,
    holdMinutes,
    plannedRiskRs,
    plannedRR,
    entrySlippagePct,
    costDragPct,
    captureRatio,
    targetReachedPct,
    findings,
    diagnosis: notes.join('; '),
  };
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

  async record(p: ManagedPosition, mode: string): Promise<ClosedTradeAnalysis | null> {
    // Rejected / cancelled entries never held anything; nothing to learn from.
    if (p.filledQuantity <= 0) return null;
    const e = this.entryFor(p, mode);
    const analysis = analyzeClosedTrade(e);
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
          ${this.sql.json({ underlying: p.underlyingSymbol ?? null, contract: (p.contract ?? null) as never, product: p.product, analysis: analysis as never })}
        ) ON CONFLICT (position_id) DO NOTHING`;
    } catch (err) {
      console.error('[trade memory] write failed', err instanceof Error ? err.message : err);
    }
    return analysis;
  }

  async recent(limit = 100): Promise<TradeLogEntry[]> {
    const rows = await this.sql<Record<string, unknown>[]>`
      SELECT * FROM trade_log ORDER BY exit_time DESC NULLS LAST LIMIT ${limit}`;
    return rows.map((r) => {
      const entry: TradeLogEntry = {
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
      };
      const meta = (r['metadata'] ?? {}) as { analysis?: ClosedTradeAnalysis };
      entry.analysis = meta.analysis ?? analyzeClosedTrade(entry);
      return entry;
    });
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
