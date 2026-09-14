import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise } from '@tradeforger/core';
import { evaluate, mustSquareOff, type RiskSnapshot } from './breakers.ts';
import { DEFAULT_LIMITS } from './limits.ts';

/** 2026-09-14 10:00 IST = 04:30 UTC — mid-session, inside the entry window. */
const midSession = () => new FixedClock(new Date('2026-09-14T04:30:00Z'));

const CAPITAL = 10_000_000 as Paise; // ₹1,00,000

function snapshot(over: Partial<RiskSnapshot> = {}): RiskSnapshot {
  return {
    startingCapitalPaise: CAPITAL,
    realisedPnlPaise: 0 as Paise,
    unrealisedPnlPaise: 0 as Paise,
    openPositions: 0,
    ordersToday: 0,
    consecutiveLosses: 0,
    rejectsLast5Min: 0,
    orderTimestamps: [],
    lastTickMs: new Date('2026-09-14T04:30:00Z').getTime(),
    marginUtilisationPct: 10,
    divergenceDetected: false,
    manualHalt: false,
    worstOpenLossPaise: 0 as Paise,
    ...over,
  };
}

const ids = (v: ReturnType<typeof evaluate>) => v.trips.map((t) => t.id);

describe('circuit breakers — clean state', () => {
  it('allows entries when nothing is wrong', () => {
    const v = evaluate(snapshot(), DEFAULT_LIMITS, midSession());
    expect(v.allowEntries).toBe(true);
    expect(v.trips).toHaveLength(0);
  });
});

describe('daily loss', () => {
  it('trips at exactly the 2% limit', () => {
    // 2% of ₹1,00,000 = ₹2,000 = 200000 paise
    const v = evaluate(
      snapshot({ realisedPnlPaise: -200_000 as Paise }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(ids(v)).toContain('DAILY_LOSS');
    expect(v.allowEntries).toBe(false);
  });

  it('does not trip one paisa below the limit', () => {
    const v = evaluate(
      snapshot({ realisedPnlPaise: -199_999 as Paise }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(ids(v)).not.toContain('DAILY_LOSS');
  });

  it('counts unrealised loss too — an open loser cannot hide from the limit', () => {
    const v = evaluate(
      snapshot({ realisedPnlPaise: -100_000 as Paise, unrealisedPnlPaise: -100_000 as Paise }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(ids(v)).toContain('DAILY_LOSS');
  });

  it('ignores profit — a good day never trips the loss breaker', () => {
    const v = evaluate(
      snapshot({ realisedPnlPaise: 500_000 as Paise }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(ids(v)).not.toContain('DAILY_LOSS');
  });

  it('still permits exits when tripped — stranding a position would be worse', () => {
    const v = evaluate(
      snapshot({ realisedPnlPaise: -500_000 as Paise }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(v.allowExits).toBe(true);
  });
});

describe('runaway-loop guards', () => {
  it('trips on orders-per-minute, counting only the last 60s', () => {
    const clock = midSession();
    const now = clock.ms();
    const v = evaluate(
      snapshot({
        orderTimestamps: [
          now - 90_000, now - 80_000,      // outside the window
          now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000, now, // 6 inside
        ],
      }),
      DEFAULT_LIMITS,
      clock,
    );
    expect(ids(v)).toContain('ORDERS_PER_MINUTE');
  });

  it('does not trip when old orders fall outside the window', () => {
    const clock = midSession();
    const now = clock.ms();
    const v = evaluate(
      snapshot({ orderTimestamps: Array.from({ length: 20 }, (_, i) => now - 61_000 - i * 1000) }),
      DEFAULT_LIMITS,
      clock,
    );
    expect(ids(v)).not.toContain('ORDERS_PER_MINUTE');
  });

  it('trips on the daily order cap', () => {
    const v = evaluate(snapshot({ ordersToday: 40 }), DEFAULT_LIMITS, midSession());
    expect(ids(v)).toContain('ORDERS_PER_DAY');
  });
});

describe('feed staleness', () => {
  it('trips after 10s without a tick during market hours', () => {
    const clock = midSession();
    const v = evaluate(snapshot({ lastTickMs: clock.ms() - 10_001 }), DEFAULT_LIMITS, clock);
    expect(ids(v)).toContain('FEED_STALE');
  });

  it('trips when no tick has ever arrived', () => {
    const v = evaluate(snapshot({ lastTickMs: null }), DEFAULT_LIMITS, midSession());
    expect(ids(v)).toContain('FEED_STALE');
  });

  it('does not trip outside market hours — a quiet feed at 20:00 is correct', () => {
    // 20:00 IST = 14:30 UTC
    const evening = new FixedClock(new Date('2026-09-14T14:30:00Z'));
    const v = evaluate(snapshot({ lastTickMs: null }), DEFAULT_LIMITS, evening);
    expect(ids(v)).not.toContain('FEED_STALE');
  });
});

describe('divergence and maintenance block exits too', () => {
  it('divergence halts everything — we no longer know what is true', () => {
    const v = evaluate(snapshot({ divergenceDetected: true }), DEFAULT_LIMITS, midSession());
    expect(ids(v)).toContain('DIVERGENCE');
    expect(v.allowExits).toBe(false);
  });

  it('maintenance window blocks exits — the API is down, not merely risky', () => {
    // 02:00 IST = 20:30 UTC previous day
    const maint = new FixedClock(new Date('2026-09-13T20:30:00Z'));
    const v = evaluate(snapshot(), DEFAULT_LIMITS, maint);
    expect(ids(v)).toContain('MAINTENANCE_WINDOW');
    expect(v.allowExits).toBe(false);
  });
});

describe('session windows', () => {
  it.each([
    ['09:16 IST — before entry window opens', '2026-09-14T03:46:00Z', true],
    ['09:20 IST — entry window opens',        '2026-09-14T03:50:00Z', false],
    ['14:44 IST — last minute of window',     '2026-09-14T09:14:00Z', false],
    ['14:45 IST — entry window closes',       '2026-09-14T09:15:00Z', true],
  ])('%s', (_label, iso, expectTrip) => {
    const v = evaluate(snapshot({ lastTickMs: new Date(iso).getTime() }), DEFAULT_LIMITS, new FixedClock(new Date(iso)));
    expect(ids(v).includes('OUTSIDE_WINDOW')).toBe(expectTrip);
  });
});

describe('square-off', () => {
  it.each([
    ['15:09 IST', '2026-09-14T09:39:00Z', false],
    ['15:10 IST', '2026-09-14T09:40:00Z', true],
    ['15:25 IST', '2026-09-14T09:55:00Z', true],
  ])('%s', (_l, iso, expected) => {
    expect(mustSquareOff(new FixedClock(new Date(iso)))).toBe(expected);
  });
});

describe('other breakers', () => {
  it('trips on consecutive losses', () => {
    expect(ids(evaluate(snapshot({ consecutiveLosses: 3 }), DEFAULT_LIMITS, midSession())))
      .toContain('CONSECUTIVE_LOSSES');
  });
  it('trips on concurrent position cap', () => {
    expect(ids(evaluate(snapshot({ openPositions: 3 }), DEFAULT_LIMITS, midSession())))
      .toContain('MAX_POSITIONS');
  });
  it('trips on reject rate', () => {
    expect(ids(evaluate(snapshot({ rejectsLast5Min: 3 }), DEFAULT_LIMITS, midSession())))
      .toContain('REJECT_RATE');
  });
  it('trips on margin utilisation', () => {
    expect(ids(evaluate(snapshot({ marginUtilisationPct: 80 }), DEFAULT_LIMITS, midSession())))
      .toContain('MARGIN');
  });
  it('trips on per-trade loss', () => {
    // 1% of ₹1,00,000 = ₹1,000 = 100000 paise
    expect(ids(evaluate(snapshot({ worstOpenLossPaise: 100_000 as Paise }), DEFAULT_LIMITS, midSession())))
      .toContain('PER_TRADE_LOSS');
  });
  it('trips on manual halt', () => {
    expect(ids(evaluate(snapshot({ manualHalt: true }), DEFAULT_LIMITS, midSession())))
      .toContain('MANUAL_HALT');
  });
  it('reports every simultaneous trip, not just the first', () => {
    const v = evaluate(
      snapshot({ openPositions: 5, consecutiveLosses: 4, rejectsLast5Min: 9 }),
      DEFAULT_LIMITS,
      midSession(),
    );
    expect(ids(v)).toEqual(expect.arrayContaining(['MAX_POSITIONS', 'CONSECUTIVE_LOSSES', 'REJECT_RATE']));
  });
});
