import { describe, it, expect } from 'vitest';
import { FixedClock, type Candle } from '@tradeforger/core';
import type { StrategyDefinition } from '../definition.ts';
import type { OptionWalls } from '../profile.ts';
import { GAP_AND_GO } from './gapAndGo.ts';
import { PDH_PDL_CPR, PDH_PDL_CPR_15M, cpr } from './pdhCpr.ts';
import { BB_RSI_REVERSION } from './bbRsiReversion.ts';
import { FAILED_BREAKOUT_TRAP } from './failedBreakout.ts';
import { OI_WALL_REVERSAL } from './oiWall.ts';

/** [open, high, low, close, volume] */
type Bar = [number, number, number, number, number];

const at = (date: string, i: number): number => Date.parse(`${date}T09:15:00+05:30`) + i * 300_000;
const day = (date: string, bars: readonly Bar[]): Candle[] =>
  bars.map(([open, high, low, close, volume], i) => ({ ts: at(date, i), open, high, low, close, volume }));

/** `n` quiet bars alternating a hair either side of `px`. */
const quiet = (n: number, px: number, volume = 1000, step = 0.1): Bar[] =>
  Array.from({ length: n }, (_, i) => {
    const [o, c] = i % 2 ? [px + step / 2, px - step / 2] : [px - step / 2, px + step / 2];
    return [o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c, volume];
  });

/** Evaluate at the close of the last bar, as the live loop and backtester do. */
function run(def: StrategyDefinition, candles: readonly Candle[], options?: OptionWalls) {
  const clock = new FixedClock(new Date(candles[candles.length - 1]!.ts + 300_000));
  return def.create().evaluate({ instrumentKey: 'K', symbol: 'S', candles, higherTf: [], clock, ...(options ? { options } : {}) });
}

const history = (px: number, volume = 1000): Candle[] => [
  ...day('2026-01-05', quiet(75, px, volume)),
  ...day('2026-01-06', quiet(75, px, volume)),
];

describe('Gap and Go', () => {
  // Previous close ≈ 100; today gaps 2.5% up on 3x opening volume.
  const opening: Bar[] = [[102.5, 103.2, 102.1, 103.0, 3000], [103.0, 103.5, 102.6, 103.2, 3000], [103.2, 103.4, 102.8, 103.1, 3000]];
  const breakBar: Bar = [103.1, 103.9, 103.0, 103.8, 4000];

  it('buys the break of the first 15-minute candle after a 1.5–4% gap on heavy volume', () => {
    const s = run(GAP_AND_GO, [...history(100), ...day('2026-01-07', [...opening, breakBar])]);
    expect(s?.side).toBe('BUY');
    expect(s!.stopLoss).toBeLessThan(s!.entry);
    expect(s!.indicators?.['triggerPrice']).toBe(103.5);
  });

  it('skips a gap above 4%, a thin opening, and a break that came earlier', () => {
    const big = opening.map(([o, h, l, c, v]): Bar => [o + 3, h + 3, l + 3, c + 3, v]);
    expect(run(GAP_AND_GO, [...history(100), ...day('2026-01-07', [...big, [106.1, 106.9, 106.0, 106.8, 4000]])])).toBeNull();
    const thin = opening.map(([o, h, l, c]): Bar => [o, h, l, c, 1000]);
    expect(run(GAP_AND_GO, [...history(100), ...day('2026-01-07', [...thin, breakBar])])).toBeNull();
    const again: Bar = [103.8, 104.2, 103.7, 104.1, 4000];
    expect(run(GAP_AND_GO, [...history(100), ...day('2026-01-07', [...opening, breakBar, again])])).toBeNull();
  });
});

describe('PDH/PDL narrow-CPR breakout', () => {
  // Yesterday: high 101, low 99, close 100 — a CPR of zero width.
  const yesterday: Bar[] = [[100, 101, 99.9, 100.5, 1000], [100.5, 100.6, 99, 99.5, 1000], ...quiet(73, 100)];
  const today: Bar[] = [...quiet(20, 100.4)];

  it('measures the central pivot range', () => {
    expect(cpr(101, 99, 100).widthPct).toBe(0);
    expect(cpr(101, 99, 100.9).widthPct).toBeCloseTo(0.6, 1);
  });

  it('buys the first close above the previous-day high on 1.8x volume when the CPR is narrow', () => {
    const s = run(PDH_PDL_CPR, [...day('2026-01-05', quiet(75, 100)), ...day('2026-01-06', yesterday), ...day('2026-01-07', [...today, [100.5, 101.4, 100.4, 101.3, 2500]])]);
    expect(s?.side).toBe('BUY');
    expect(s!.indicators?.['pdh']).toBe(101);
  });

  it('produces valid 15m PDH_PDL_CPR_15M signals on resampled 15m bars', () => {
    const d1 = day('2026-01-05', quiet(25, 100)).map((b, i) => ({ ...b, ts: at('2026-01-05', i * 3) }));
    const d2 = yesterday.slice(0, 25).map((bar, i) => ({
      ts: at('2026-01-06', i * 3), open: bar[0], high: bar[1], low: bar[2], close: bar[3], volume: bar[4] * 3,
    }));
    const d3Bars: Bar[] = [...quiet(10, 100.4, 1000), [100.5, 101.5, 100.4, 101.4, 3000]];
    const d3 = d3Bars.map((bar, i) => ({
      ts: at('2026-01-07', i * 3), open: bar[0], high: bar[1], low: bar[2], close: bar[3], volume: bar[4],
    }));
    const all15 = [...d1, ...d2, ...d3];
    const clock = new FixedClock(new Date(all15[all15.length - 1]!.ts + 900_000));
    const s = PDH_PDL_CPR_15M.create().evaluate({ instrumentKey: 'K', symbol: 'S', candles: all15, higherTf: [], clock });
    expect(s?.side).toBe('BUY');
    expect(s?.strategyId).toBe('PDH_PDL_CPR_15M');
  });

  it('skips a thin breakout and a wide-CPR day', () => {
    const thin = run(PDH_PDL_CPR, [...day('2026-01-05', quiet(75, 100)), ...day('2026-01-06', yesterday), ...day('2026-01-07', [...today, [100.5, 101.4, 100.4, 101.3, 1200]])]);
    expect(thin).toBeNull();
    // High 102, low 98, close 101.8 -> CPR width ~1.2% (> 0.9% maxCprWidthPct).
    const wide: Bar[] = [[100, 102, 99.9, 100.5, 1000], [100.5, 100.6, 98, 99.5, 1000], ...quiet(73, 101.8)];
    expect(run(PDH_PDL_CPR, [...day('2026-01-05', quiet(75, 100)), ...day('2026-01-06', wide), ...day('2026-01-07', [...quiet(20, 101.8), [101.8, 102.5, 101.7, 102.4, 2500]])])).toBeNull();
  });
});

describe('Bollinger + RSI mean reversion', () => {
  // A ranging tape at 100, a sharp stretch down through the band, then a close back inside.
  const range: Bar[] = quiet(30, 100, 3000, 0.05);
  const stretch: Bar[] = [[100, 100.02, 99.55, 99.6, 1500], [99.6, 99.62, 99.15, 99.2, 1500], [99.2, 99.22, 98.75, 98.8, 1500]];
  const reclaim: Bar = [98.8, 99.3, 98.78, 99.25, 1500];

  it('buys the close back inside the lower band in a range, targeting VWAP', () => {
    const s = run(BB_RSI_REVERSION, [...history(100), ...day('2026-01-07', [...range, ...stretch, reclaim])]);
    expect(s?.side).toBe('BUY');
    expect(s!.target).toBeGreaterThan(s!.entry);
    expect(s!.indicators?.['adx']).toBeLessThan(18);
  });

  it('does not buy while price is still outside the band', () => {
    expect(run(BB_RSI_REVERSION, [...history(100), ...day('2026-01-07', [...range, ...stretch])])).toBeNull();
  });
});

describe('Failed breakout trap', () => {
  const opening: Bar[] = [[100, 100.6, 99.8, 100.2, 1000], [100.2, 100.5, 99.9, 100.1, 1000], [100.1, 100.4, 99.9, 100.2, 1000]];
  const inside: Bar[] = quiet(8, 100.2);
  const reclaim: Bar = [100.75, 100.85, 100.3, 100.35, 1000];

  it('fades a thin break of the opening-range high that closes back inside', () => {
    const s = run(FAILED_BREAKOUT_TRAP, [...history(100.2), ...day('2026-01-07', [...opening, ...inside, [100.3, 100.9, 100.25, 100.8, 900], reclaim])]);
    expect(s?.side).toBe('SELL');
    expect(s!.indicators?.['level']).toBe(100.6);
    expect(s!.stopLoss).toBeGreaterThan(100.85);
  });

  it('leaves a heavy-volume breakout alone', () => {
    expect(run(FAILED_BREAKOUT_TRAP, [...history(100.2), ...day('2026-01-07', [...opening, ...inside, [100.3, 100.9, 100.25, 100.8, 3000], reclaim])])).toBeNull();
  });
});

describe('Option-chain OI wall reversal', () => {
  // Futures bars ≈ 21,900; spot 21,850 (basis 50); put wall 21,800 → 21,850 in futures terms.
  const bars: Bar[] = [
    ...quiet(30, 21900, 1000, 10).map(([o, h, l, c, v]): Bar => [o, h + 10, l - 10, c, v]),
    [21900, 21905, 21870, 21875, 1000], [21875, 21880, 21852, 21860, 1000], [21860, 21902, 21855, 21900, 1000],
  ];
  const candles = [...history(21900), ...day('2026-01-07', bars)];
  const t = candles[candles.length - 1]!.ts + 300_000;
  const walls: OptionWalls = { spot: 21850, callWall: 22200, putWall: 21800, callWallOiChange: 0, putWallOiChange: 50_000, at: t - 30_000 };

  it('buys a bounce off the put wall while writers add OI there', () => {
    const s = run(OI_WALL_REVERSAL, candles, walls);
    expect(s?.side).toBe('BUY');
    expect(s!.stopLoss).toBeLessThan(21850 * 100);
  });

  it('needs a fresh chain and OI being added at the wall', () => {
    expect(run(OI_WALL_REVERSAL, candles)).toBeNull();
    expect(run(OI_WALL_REVERSAL, candles, { ...walls, putWallOiChange: -10_000 })).toBeNull();
    expect(run(OI_WALL_REVERSAL, candles, { ...walls, at: t - 20 * 60_000 })).toBeNull();
  });
});
