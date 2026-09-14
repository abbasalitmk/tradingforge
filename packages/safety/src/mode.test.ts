import { describe, it, expect } from 'vitest';
import { FixedClock } from '@tradeforger/core';
import { canEnterLive, armUntilSessionEnd, effectiveMode, isDowngrade, placesRealOrders } from './mode.ts';

const PHRASE = 'TRADE LIVE WITH REAL MONEY';

describe('only LIVE reaches real money', () => {
  it.each([
    ['PAPER', false], ['SANDBOX', false], ['LIVE_ARMED', false], ['LIVE', true],
  ] as const)('%s → %s', (mode, expected) => {
    expect(placesRealOrders(mode)).toBe(expected);
  });
});

describe('entering LIVE requires every gate independently', () => {
  it('refuses without the env flag', () => {
    const r = canEnterLive({ LIVE_TRADING: undefined }, PHRASE, PHRASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.reason).toBe('LIVE_TRADING_FLAG_OFF');
  });

  it('refuses when the flag is any truthy-looking value other than "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'True']) {
      expect(canEnterLive({ LIVE_TRADING: v }, PHRASE, PHRASE).ok).toBe(false);
    }
  });

  it('refuses on a confirmation typo', () => {
    const r = canEnterLive({ LIVE_TRADING: 'true' }, 'trade live with real money', PHRASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.reason).toBe('CONFIRMATION_MISMATCH');
  });

  it('allows only when flag and phrase both match exactly', () => {
    expect(canEnterLive({ LIVE_TRADING: 'true' }, PHRASE, PHRASE).ok).toBe(true);
  });
});

describe('arming expires with the session', () => {
  it('arms until 15:30 IST, not indefinitely', () => {
    // 10:00 IST = 04:30 UTC → 5h30m of session left
    const clock = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const state = armUntilSessionEnd(clock, 'abba');
    expect(state.armedUntilMs).toBe(clock.ms() + 330 * 60_000);
    expect(effectiveMode(state, clock)).toBe('LIVE');
  });

  it('degrades to LIVE_ARMED once the arm expires — cannot stay live overnight', () => {
    const clock = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const state = armUntilSessionEnd(clock, 'abba');
    clock.advance(331 * 60_000); // past 15:30 IST
    expect(effectiveMode(state, clock)).toBe('LIVE_ARMED');
    expect(placesRealOrders(effectiveMode(state, clock))).toBe(false);
  });

  it('treats a LIVE state with no expiry as not live', () => {
    const clock = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    expect(effectiveMode({ mode: 'LIVE', armedUntilMs: null, armedBy: null }, clock)).toBe('LIVE_ARMED');
  });

  it('leaves non-LIVE modes untouched', () => {
    const clock = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    expect(effectiveMode({ mode: 'PAPER', armedUntilMs: null, armedBy: null }, clock)).toBe('PAPER');
  });
});

describe('downgrades are free, upgrades are not', () => {
  it('recognises downgrades', () => {
    expect(isDowngrade('LIVE', 'PAPER')).toBe(true);
    expect(isDowngrade('LIVE_ARMED', 'SANDBOX')).toBe(true);
  });
  it('rejects upgrades and no-ops', () => {
    expect(isDowngrade('PAPER', 'LIVE')).toBe(false);
    expect(isDowngrade('PAPER', 'PAPER')).toBe(false);
  });
});
