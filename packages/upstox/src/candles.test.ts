import { describe, it, expect } from 'vitest';
import { toCandles } from './client.ts';

describe('candle ordering', () => {
  it('normalises Upstox newest-first candles to oldest-first', () => {
    // Shape and order exactly as the live API returns them.
    const c = toCandles([
      ['2026-11-18T15:25:00+05:30', 1364, 1365, 1362, 1363, 9_000, 0],
      ['2026-11-18T15:20:00+05:30', 1361, 1364, 1360, 1364, 8_000, 0],
      ['2026-11-18T09:15:00+05:30', 1370, 1376.5, 1366, 1368, 90_000, 0],
    ]);
    expect(c.map((x) => x.close)).toEqual([1368, 1364, 1363]);
    expect(c[0]!.ts).toBeLessThan(c[2]!.ts);
  });
});
