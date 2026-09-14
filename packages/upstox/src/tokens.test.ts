import { describe, it, expect } from 'vitest';
import { FixedClock } from '@tradeforger/core';
import { TokenStore, nextTokenExpiry } from './tokens.ts';

describe('tokens expire at 03:30 IST, not 24h after issue', () => {
  it('a token issued at 03:00 IST dies in 30 minutes', () => {
    // 03:00 IST = 21:30 UTC previous day
    const issued = new Date('2026-09-13T21:30:00Z');
    const expiry = nextTokenExpiry(issued);
    expect(expiry - issued.getTime()).toBe(30 * 60_000);
  });

  it('a token issued at 10:00 IST lives until 03:30 IST next day', () => {
    const issued = new Date('2026-09-14T04:30:00Z'); // 10:00 IST
    const expiry = nextTokenExpiry(issued);
    expect(expiry - issued.getTime()).toBe((17 * 60 + 30) * 60_000);
  });

  it('never returns an expiry in the past', () => {
    for (const iso of ['2026-09-14T00:00:00Z', '2026-09-14T21:59:00Z', '2026-09-14T22:01:00Z']) {
      expect(nextTokenExpiry(new Date(iso))).toBeGreaterThan(new Date(iso).getTime());
    }
  });
});

describe('TokenStore fails closed', () => {
  it('returns null for an expired trading token rather than a dead string', () => {
    const c = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const s = new TokenStore(c);
    s.setTrading('tok_abc');
    expect(s.trading()).toBe('tok_abc');

    c.advance(18 * 60 * 60_000); // past next 03:30 IST
    expect(s.trading()).toBeNull();
  });

  it('reports impending expiry so a refresh can be scheduled', () => {
    const c = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const s = new TokenStore(c);
    s.setTrading('tok');
    expect(s.expiresWithin(60 * 60_000)).toBe(false);
    c.advance(17 * 60 * 60_000); // 30 min left
    expect(s.expiresWithin(60 * 60_000)).toBe(true);
  });

  it('keeps the analytics token independent of the daily token lifecycle', () => {
    const c = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const s = new TokenStore(c, { analyticsToken: 'analytics_xyz' });
    s.setTrading('tok');
    c.advance(48 * 60 * 60_000);
    expect(s.trading()).toBeNull();
    expect(s.data()).toBe('analytics_xyz'); // still valid — ~1y lifetime
  });

  it('clearTrading leaves analytics intact', () => {
    const c = new FixedClock(new Date('2026-09-14T04:30:00Z'));
    const s = new TokenStore(c, { analyticsToken: 'a' });
    s.setTrading('t');
    s.clearTrading();
    expect(s.trading()).toBeNull();
    expect(s.data()).toBe('a');
  });
});
