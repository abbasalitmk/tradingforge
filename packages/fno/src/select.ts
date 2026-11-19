import type { ChainRow, OptionChain, OptionQuote } from './chain.ts';
import { daysToExpiry } from './contracts.ts';

/**
 * First expiry with at least `minDte` calendar days left.
 *
 * Expiry-day (0 DTE) options are excluded by default: gamma makes the premium
 * swing several times faster than the underlying and theta takes what is left
 * by the close. That is a different, much more dangerous game than a
 * directional intraday trade, and it is not one this system plays by accident.
 */
export function pickExpiry(expiries: readonly string[], today: string, minDte = 1): string | null {
  return [...expiries].sort().find((e) => daysToExpiry(e, today) >= minDte) ?? null;
}

export interface StrikeParams {
  /** |delta| aimed for. ~0.5 is ATM: responsive without paying for deep ITM. */
  readonly targetDelta: number;
  readonly minDelta: number;
  readonly maxDelta: number;
  /** Bid/ask spread as % of mid. Wider and the round trip eats the edge. */
  readonly maxSpreadPct: number;
  /** OI as a fraction of the busiest strike on that side near ATM. */
  readonly minRelativeOi: number;
  readonly minPremium: number;
  readonly maxPremium: number;
  /** Strikes either side of ATM considered at all. */
  readonly window: number;
}

export const DEFAULT_STRIKE_PARAMS: StrikeParams = {
  targetDelta: 0.5,
  minDelta: 0.3,
  maxDelta: 0.75,
  maxSpreadPct: 3,
  minRelativeOi: 0.05,
  minPremium: 5,
  maxPremium: 2_000,
  window: 6,
};

export interface StrikePick {
  readonly row: ChainRow;
  readonly quote: OptionQuote;
  readonly delta: number | null;
  readonly spreadPct: number | null;
}

export const spreadPct = (q: OptionQuote): number | null =>
  q.bid !== null && q.ask !== null && q.ask >= q.bid
    ? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100
    : null;

/**
 * Choose the strike to BUY for a directional view: the liquid contract whose
 * |delta| is closest to the target. When greeks are missing, falls back to the
 * ATM strike — moneyness is the next-best proxy for delta.
 */
export function pickStrike(
  chain: OptionChain,
  type: 'CE' | 'PE',
  p: StrikeParams = DEFAULT_STRIKE_PARAMS,
): { ok: true; pick: StrikePick } | { ok: false; reasons: string[] } {
  const rows = chain.rows;
  let atmIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i]!.strike - chain.spot) < Math.abs(rows[atmIdx]!.strike - chain.spot)) atmIdx = i;
  }
  const near = rows.slice(Math.max(0, atmIdx - p.window), atmIdx + p.window + 1);
  const leg = (r: ChainRow): OptionQuote | null => (type === 'CE' ? r.call : r.put);
  const maxOi = Math.max(0, ...near.map((r) => leg(r)?.oi ?? 0));

  const reasons = new Map<string, number>();
  const reject = (why: string): void => { reasons.set(why, (reasons.get(why) ?? 0) + 1); };

  const candidates: StrikePick[] = [];
  for (const row of near) {
    const q = leg(row);
    if (!q || q.ltp === null) { reject('no price'); continue; }
    const premium = q.ask ?? q.ltp;
    if (premium < p.minPremium || premium > p.maxPremium) { reject('premium out of band'); continue; }
    const sp = spreadPct(q);
    if (sp === null) { reject('no two-sided quote'); continue; }
    if (sp > p.maxSpreadPct) { reject(`spread > ${p.maxSpreadPct}%`); continue; }
    if (maxOi > 0 && q.oi < maxOi * p.minRelativeOi) { reject('thin open interest'); continue; }
    const delta = q.delta !== null ? Math.abs(q.delta) : null;
    if (delta !== null && (delta < p.minDelta || delta > p.maxDelta)) { reject('delta out of band'); continue; }
    candidates.push({ row, quote: q, delta, spreadPct: sp });
  }

  if (candidates.length === 0) {
    return { ok: false, reasons: [...reasons].map(([why, count]) => `${count} strikes: ${why}`) };
  }

  const atmStrike = rows[atmIdx]!.strike;
  const distance = (c: StrikePick): number =>
    c.delta !== null ? Math.abs(c.delta - p.targetDelta) : Math.abs(c.row.strike - atmStrike) / chain.spot;
  candidates.sort((a, b) => distance(a) - distance(b) || (a.spreadPct ?? 0) - (b.spreadPct ?? 0));
  return { ok: true, pick: candidates[0]! };
}
