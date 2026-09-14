import type { PositionRecord } from './machine.ts';

export interface BrokerPosition {
  readonly instrumentKey: string;
  readonly quantity: number;
  readonly averagePrice: number;
}

export type Divergence =
  | { kind: 'MISSING_AT_BROKER'; positionId: string; detail: string }
  | { kind: 'UNKNOWN_AT_ENGINE'; instrumentKey: string; detail: string }
  | { kind: 'QUANTITY_MISMATCH'; positionId: string; detail: string }
  | { kind: 'ORPHANED_BRACKET'; gttOrderId: string; detail: string };

/**
 * Compare engine state against the broker's.
 *
 * The broker is always right. This function does not repair anything — it
 * reports, and any divergence trips the DIVERGENCE breaker, which is one of the
 * two breakers that also blocks exits. Acting on a view of the world we know to
 * be wrong is how a small desync becomes a large loss.
 *
 * Runs at boot before trading is permitted, and every 5s while MANAGING.
 */
export function reconcile(
  engine: readonly PositionRecord[],
  brokerPositions: readonly BrokerPosition[],
  liveGttIds: ReadonlySet<string>,
): Divergence[] {
  const out: Divergence[] = [];
  const byKey = new Map(brokerPositions.map((p) => [p.instrumentKey, p]));
  const enginePositions = engine.filter((p) => p.filledQuantity > 0);
  const engineKeys = new Set(enginePositions.map((p) => p.instrumentKey));

  for (const p of enginePositions) {
    const broker = byKey.get(p.instrumentKey);
    if (!broker || broker.quantity === 0) {
      out.push({
        kind: 'MISSING_AT_BROKER',
        positionId: p.id,
        detail: `engine holds ${p.filledQuantity} of ${p.symbol}, broker holds none`,
      });
      continue;
    }
    if (Math.abs(broker.quantity) !== p.filledQuantity) {
      out.push({
        kind: 'QUANTITY_MISMATCH',
        positionId: p.id,
        detail: `engine ${p.filledQuantity}, broker ${broker.quantity}`,
      });
    }
    if (p.gttOrderId !== null && !liveGttIds.has(p.gttOrderId)) {
      out.push({
        kind: 'ORPHANED_BRACKET',
        gttOrderId: p.gttOrderId,
        detail: `${p.symbol} bracket ${p.gttOrderId} no longer live at broker`,
      });
    }
  }

  // A position the broker holds but we do not know about — a manual trade in
  // the Upstox app, or our own order that we lost track of.
  for (const b of brokerPositions) {
    if (b.quantity !== 0 && !engineKeys.has(b.instrumentKey)) {
      out.push({
        kind: 'UNKNOWN_AT_ENGINE',
        instrumentKey: b.instrumentKey,
        detail: `broker holds ${b.quantity} of ${b.instrumentKey}, engine has no record`,
      });
    }
  }

  return out;
}
