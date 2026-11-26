import { describe, it, expect } from 'vitest';
import type { Candle } from '@tradeforger/core';
import { trendBias15, marketDirection, dayChangePct } from './bias.ts';
import { sectorOf } from './sectors.ts';

/** `n` session days of 5-min bars (09:15–15:25 IST) stepping `drift` per bar. */
function trending(days: number, drift: number, start = 100): Candle[] {
  const out: Candle[] = [];
  let px = start;
  for (let d = 0; d < days; d++) {
    const open = new Date(`2026-11-${String(10 + d).padStart(2, '0')}T09:15:00+05:30`).getTime();
    for (let i = 0; i < 75; i++) {
      const o = px;
      px += drift;
      out.push({ ts: open + i * 300_000, open: o, close: px, high: Math.max(o, px) + 0.05, low: Math.min(o, px) - 0.05, volume: 1000 });
    }
  }
  return out;
}

describe('15-minute trend bias', () => {
  it('is long in a steady uptrend and short in a downtrend', () => {
    expect(trendBias15(trending(3, 0.1)).side).toBe('BUY');
    expect(trendBias15(trending(3, -0.1, 200)).side).toBe('SELL');
  });

  it('reads an index, which has no volume, off the EMAs and ADX', () => {
    const index = trending(3, 0.1).map((c) => ({ ...c, volume: 0 }));
    const b = trendBias15(index);
    expect(b.vwap).toBeNull();
    expect(b.side).toBe('BUY');
  });

  it('refuses to call a bias without EMA50 history', () => {
    const b = trendBias15(trending(1, 0.1));
    expect(b.side).toBeNull();
    expect(b.reason).toContain('not enough');
  });

  it('ignores the 15-minute bar still forming', () => {
    const done = trending(3, 0.1);
    // Two 5-min bars of the next 15-min slot collapse; that slot is not complete.
    const t0 = done[done.length - 1]!.ts + 300_000;
    const crash = (i: number): Candle => ({ ts: t0 + i * 300_000, open: 60, close: 60, high: 60, low: 60, volume: 1 });
    const b = trendBias15([...done, crash(0), crash(1)]);
    expect(b.close).toBe(trendBias15(done).close);
    expect(trendBias15([...done, crash(0), crash(1), crash(2)]).close).toBe(60);
  });
});

describe('sector map', () => {
  it('knows Nifty 500 stocks and nothing else', () => {
    expect(sectorOf('HDFCBANK')).toBe('Financial Services');
    expect(sectorOf('infy')).toBe('Information Technology');
    expect(sectorOf('NIFTY')).toBeNull();
  });
});

describe('market direction and relative strength', () => {
  it('reads the index direction from its 15-min EMAs', () => {
    const up = trending(3, 0.1).map((c) => ({ ...c, volume: 0 }));
    expect(marketDirection(up)).toBe('BUY');
    const down = trending(3, -0.1, 200).map((c) => ({ ...c, volume: 0 }));
    expect(marketDirection(down)).toBe('SELL');
  });

  it('with requireAboveOpen, an uptrend trading under today\'s open has no direction', () => {
    const up = trending(3, 0.1).map((c) => ({ ...c, volume: 0 }));
    const last = up[up.length - 1]!;
    const todayOpen = up[150]!.open;
    // Today's last bar dips below the session open while the EMAs still point up.
    const dipped = [...up.slice(0, -1), { ...last, close: todayOpen - 0.5, low: todayOpen - 0.6 }];
    expect(marketDirection(dipped)).toBe('BUY');
    expect(marketDirection(dipped, { requireAboveOpen: true })).toBeNull();
  });

  it('measures the day change from the previous session close', () => {
    const bars = trending(2, 0.1);
    const prevClose = bars[74]!.close;
    expect(dayChangePct(bars)).toBeCloseTo(((bars[149]!.close - prevClose) / prevClose) * 100, 9);
    expect(dayChangePct(bars.slice(0, 75))).toBeNull();
  });
});
