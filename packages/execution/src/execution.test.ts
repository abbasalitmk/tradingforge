import { describe, it, expect, vi } from 'vitest';
import type { Paise, PositionId } from '@tradeforger/core';
import { PositionMachine, TransitionError, detectOrphan, isActive, type PositionRecord } from './machine.ts';
import { reconcile, type BrokerPosition } from './reconcile.ts';

const P = (r: number) => Math.round(r * 100) as Paise;

function pos(over: Partial<PositionRecord> = {}): PositionRecord {
  return {
    id: 'pos_TEST' as PositionId,
    instrumentKey: 'NSE_EQ|INE002A01018',
    symbol: 'RELIANCE',
    side: 'BUY',
    state: 'CANDIDATE',
    quantity: 10,
    filledQuantity: 0,
    entry: P(1000),
    avgEntry: null,
    stopLoss: P(980),
    target: P(1040),
    entryOrderId: null,
    gttOrderId: null,
    openedAt: 0,
    ...over,
  };
}

describe('state machine', () => {
  it('walks the happy path end to end', async () => {
    const seen: string[] = [];
    const m = new PositionMachine(async (_p, from, to) => { seen.push(`${from}→${to}`); });
    const p = pos();

    for (const to of [
      'AI_REVIEWED', 'RISK_APPROVED', 'ENTRY_SENT', 'ENTRY_ACKED',
      'ENTRY_FILLED', 'BRACKET_ARMED', 'MANAGING', 'EXIT_TRIGGERED',
      'EXIT_FILLED', 'CLOSED',
    ] as const) {
      await m.transition(p, to);
    }
    expect(p.state).toBe('CLOSED');
    expect(seen).toHaveLength(10);
  });

  it('throws on an illegal jump rather than tolerating it', async () => {
    const m = new PositionMachine(async () => {});
    const p = pos({ state: 'ENTRY_SENT' });
    // Skipping ENTRY_FILLED would mean we lost track of a fill.
    await expect(m.transition(p, 'MANAGING')).rejects.toThrow(TransitionError);
    expect(p.state).toBe('ENTRY_SENT');
  });

  it('persists BEFORE mutating — a failed write leaves state unchanged', async () => {
    const m = new PositionMachine(async () => { throw new Error('db down'); });
    const p = pos({ state: 'RISK_APPROVED' });
    await expect(m.transition(p, 'ENTRY_SENT')).rejects.toThrow('db down');
    // The journal can be ahead of reality, never behind it.
    expect(p.state).toBe('RISK_APPROVED');
  });

  it('treats a self-transition as a no-op', async () => {
    const hook = vi.fn(async () => {});
    const m = new PositionMachine(hook);
    const p = pos({ state: 'MANAGING' });
    await m.transition(p, 'MANAGING');
    expect(hook).not.toHaveBeenCalled();
  });

  it('allows terminal states no exits', async () => {
    const m = new PositionMachine(async () => {});
    for (const s of ['CLOSED', 'REJECTED', 'CANCELLED'] as const) {
      await expect(m.transition(pos({ state: s }), 'MANAGING')).rejects.toThrow(TransitionError);
    }
  });
});

describe('ORPHANED — the most dangerous state', () => {
  it('can be reached from any live state, bypassing the transition table', async () => {
    const m = new PositionMachine(async () => {});
    for (const s of ['ENTRY_SENT', 'ENTRY_FILLED', 'MANAGING', 'BRACKET_ARMED'] as const) {
      const p = pos({ state: s });
      await m.orphan(p, 'test');
      expect(p.state).toBe('ORPHANED');
    }
  });

  it('does not re-orphan a closed position', async () => {
    const hook = vi.fn(async () => {});
    const m = new PositionMachine(hook);
    await m.orphan(pos({ state: 'CLOSED' }), 'test');
    expect(hook).not.toHaveBeenCalled();
  });

  it('detects a filled position whose bracket is not live at the broker', () => {
    const p = pos({ state: 'MANAGING', filledQuantity: 10, gttOrderId: 'gtt-1' });
    expect(detectOrphan(p, new Set(['gtt-other']))).toBe(true);
    expect(detectOrphan(p, new Set(['gtt-1']))).toBe(false);
  });

  it('treats a filled entry with no bracket yet as orphaned', () => {
    expect(detectOrphan(pos({ state: 'ENTRY_FILLED', filledQuantity: 10 }), new Set())).toBe(true);
  });

  it('does not flag a position holding no shares', () => {
    expect(detectOrphan(pos({ state: 'ENTRY_SENT', filledQuantity: 0 }), new Set())).toBe(false);
  });
});

describe('isActive', () => {
  it('marks positions needing management after a restart', () => {
    expect(isActive('MANAGING')).toBe(true);
    expect(isActive('ENTRY_FILLED')).toBe(true);
    expect(isActive('ORPHANED')).toBe(true);
    expect(isActive('CLOSED')).toBe(false);
    expect(isActive('CANDIDATE')).toBe(false);
  });
});

describe('reconciliation — the broker is always right', () => {
  const bp = (key: string, qty: number): BrokerPosition =>
    ({ instrumentKey: key, quantity: qty, averagePrice: 1000 });

  it('reports nothing when the two views agree', () => {
    const p = pos({ state: 'MANAGING', filledQuantity: 10, gttOrderId: 'gtt-1' });
    expect(reconcile([p], [bp(p.instrumentKey, 10)], new Set(['gtt-1']))).toHaveLength(0);
  });

  it('flags a position the broker does not hold', () => {
    const p = pos({ state: 'MANAGING', filledQuantity: 10, gttOrderId: 'gtt-1' });
    const d = reconcile([p], [], new Set(['gtt-1']));
    expect(d[0]!.kind).toBe('MISSING_AT_BROKER');
  });

  it('flags a quantity mismatch — a partial fill we did not record', () => {
    const p = pos({ state: 'MANAGING', filledQuantity: 10, gttOrderId: 'gtt-1' });
    const d = reconcile([p], [bp(p.instrumentKey, 7)], new Set(['gtt-1']));
    expect(d.some((x) => x.kind === 'QUANTITY_MISMATCH')).toBe(true);
  });

  it('flags a position the broker holds that we know nothing about', () => {
    // e.g. a manual trade placed in the Upstox app.
    const d = reconcile([], [bp('NSE_EQ|OTHER', 5)], new Set());
    expect(d[0]!.kind).toBe('UNKNOWN_AT_ENGINE');
  });

  it('flags a bracket that vanished at the broker', () => {
    const p = pos({ state: 'MANAGING', filledQuantity: 10, gttOrderId: 'gtt-gone' });
    const d = reconcile([p], [bp(p.instrumentKey, 10)], new Set());
    expect(d.some((x) => x.kind === 'ORPHANED_BRACKET')).toBe(true);
  });

  it('ignores unfilled positions — nothing to reconcile yet', () => {
    expect(reconcile([pos({ state: 'ENTRY_SENT', filledQuantity: 0 })], [], new Set())).toHaveLength(0);
  });
});
