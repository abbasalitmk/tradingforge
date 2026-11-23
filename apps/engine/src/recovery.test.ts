import { describe, it, expect } from 'vitest';
import type { Paise, PositionId, PositionState } from '@tradeforger/core';
import { planRecovery } from './recovery.ts';
import type { ManagedPosition } from './trader.ts';

const TODAY = '2026-11-20';
const todayMs = new Date('2026-11-20T10:00:00+05:30').getTime();
const yesterdayMs = new Date('2026-11-19T10:00:00+05:30').getTime();

const pos = (over: Partial<ManagedPosition> = {}): ManagedPosition => ({
  id: 'pos_1' as PositionId, instrumentKey: 'NSE_EQ|X', symbol: 'X', side: 'BUY', state: 'MANAGING' as PositionState,
  quantity: 10, filledQuantity: 10, entry: 10_000 as Paise, avgEntry: 10_000 as Paise,
  stopLoss: 9_800 as Paise, target: 10_400 as Paise, entryOrderId: null, gttOrderId: 'gtt-1', openedAt: todayMs,
  segment: 'EQ', style: 'INTRADAY', signalId: 's', product: 'I', broker: 'PAPER',
  costPaise: 100_000 as Paise, timeStopMin: null, trailingGap: null,
  mfePaise: 0, maePaise: 0, filledAt: todayMs, exitPrice: null, exitReason: null, realisedPnl: null, closedAt: null,
  ...over,
});
const ok = { gttFound: true, exitOrdersOffBook: [] };

describe('restart recovery plan', () => {
  it('drops anything that never reached a broker', () => {
    for (const s of ['CANDIDATE', 'AI_REVIEWED', 'RISK_APPROVED'] as const) {
      expect(planRecovery(pos({ state: s }), TODAY, null)).toMatchObject({ kind: 'DROP', to: 'REJECTED' });
    }
  });

  it('keeps an orphan an orphan — only a human clears it', () => {
    expect(planRecovery(pos({ state: 'ORPHANED', broker: 'UPSTOX' }), TODAY, null).kind).toBe('ADOPT');
  });

  describe('paper', () => {
    it('re-adopts an open position from today', () => {
      expect(planRecovery(pos(), TODAY, null).kind).toBe('ADOPT');
    });
    it('cancels an entry that died with the simulator', () => {
      expect(planRecovery(pos({ state: 'ENTRY_ACKED', filledQuantity: 0 }), TODAY, null)).toMatchObject({ kind: 'DROP', to: 'CANCELLED' });
    });
    it('finishes an in-flight exit and squares off an overdue intraday position', () => {
      expect(planRecovery(pos({ state: 'EXIT_TRIGGERED' }), TODAY, null).kind).toBe('EXIT_NEXT_TICK');
      expect(planRecovery(pos({ openedAt: yesterdayMs }), TODAY, null).kind).toBe('EXIT_NEXT_TICK');
    });
    it('carries a swing position overnight', () => {
      expect(planRecovery(pos({ product: 'D', style: 'SWING', openedAt: yesterdayMs }), TODAY, null).kind).toBe('ADOPT');
    });
  });

  describe('upstox (real money)', () => {
    const live = (over: Partial<ManagedPosition> = {}) => pos({ broker: 'UPSTOX', ...over });

    it('re-adopts a verified position with a live bracket', () => {
      expect(planRecovery(live(), TODAY, ok).kind).toBe('ADOPT');
    });
    it('adopts unverified (no token yet) for re-verification at login', () => {
      expect(planRecovery(live(), TODAY, null).kind).toBe('ADOPT');
    });
    it('orphans a placement whose outcome is unknown', () => {
      expect(planRecovery(live({ state: 'ENTRY_SENT', gttOrderId: null }), TODAY, ok).kind).toBe('ORPHAN');
    });
    it('orphans an exit that was in flight', () => {
      expect(planRecovery(live({ state: 'EXIT_TRIGGERED' }), TODAY, ok).kind).toBe('ORPHAN');
    });
    it('orphans yesterday’s intraday position — Upstox already squared it off', () => {
      expect(planRecovery(live({ openedAt: yesterdayMs }), TODAY, ok).kind).toBe('ORPHAN');
    });
    it('orphans a position whose bracket is gone or fired while the engine was down', () => {
      expect(planRecovery(live({ product: 'D', openedAt: yesterdayMs }), TODAY, { gttFound: false, exitOrdersOffBook: [] }).kind).toBe('ORPHAN');
      const fired = planRecovery(live({ product: 'D', openedAt: yesterdayMs }), TODAY, { gttFound: true, exitOrdersOffBook: ['250101000123'] });
      expect(fired.kind).toBe('ORPHAN');
      expect('reason' in fired && fired.reason).toContain('250101000123');
    });
    it('keeps a verified overnight swing position', () => {
      expect(planRecovery(live({ product: 'D', openedAt: yesterdayMs }), TODAY, ok).kind).toBe('ADOPT');
    });
  });
});
