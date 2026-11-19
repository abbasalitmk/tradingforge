import type { schemas } from '@tradeforger/upstox';

export interface OptionQuote {
  readonly instrumentKey: string;
  readonly ltp: number | null;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly closePrice: number | null;
  readonly oi: number;
  readonly prevOi: number;
  readonly volume: number;
  /** Implied volatility in percent, as Upstox reports it. */
  readonly iv: number | null;
  readonly delta: number | null;
  readonly gamma: number | null;
  /** Premium decay per day, rupees (negative for a long option). */
  readonly theta: number | null;
  readonly vega: number | null;
}

export interface ChainRow {
  readonly strike: number;
  readonly call: OptionQuote | null;
  readonly put: OptionQuote | null;
}

export interface OptionChain {
  readonly underlyingKey: string;
  readonly expiry: string;
  readonly spot: number;
  /** Ascending by strike. */
  readonly rows: readonly ChainRow[];
  readonly fetchedAt: number;
}

const n = (v: number | null | undefined): number | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : v;
const pos = (v: number | null | undefined): number | null => {
  const x = n(v);
  return x !== null && x > 0 ? x : null;
};

function quote(leg: schemas.OptionLeg | undefined): OptionQuote | null {
  if (!leg) return null;
  const m = leg.market_data;
  const g = leg.option_greeks;
  return {
    instrumentKey: leg.instrument_key,
    ltp: pos(m?.ltp),
    bid: pos(m?.bid_price),
    ask: pos(m?.ask_price),
    closePrice: pos(m?.close_price),
    oi: n(m?.oi) ?? 0,
    prevOi: n(m?.prev_oi) ?? 0,
    volume: n(m?.volume) ?? 0,
    iv: pos(g?.iv),
    delta: n(g?.delta),
    gamma: n(g?.gamma),
    theta: n(g?.theta),
    vega: n(g?.vega),
  };
}

/** Normalise GET /v2/option/chain. Null when there is no usable spot price. */
export function chainFromUpstox(rows: readonly schemas.OptionStrike[], fetchedAt: number): OptionChain | null {
  const first = rows[0];
  if (!first || !(first.underlying_spot_price > 0)) return null;
  return {
    underlyingKey: first.underlying_key,
    expiry: first.expiry,
    spot: first.underlying_spot_price,
    rows: rows
      .map((r) => ({ strike: r.strike_price, call: quote(r.call_options), put: quote(r.put_options) }))
      .sort((a, b) => a.strike - b.strike),
    fetchedAt,
  };
}

export type Buildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';

/**
 * The standard price/OI quadrant. OI rising with price means new longs; OI
 * rising against price means new shorts (writers); OI falling means positions
 * closing. Below the thresholds the move is noise and reads NEUTRAL.
 */
export function classifyBuildup(pricePct: number, oiPct: number, minPricePct = 0.5, minOiPct = 1): Buildup {
  if (Math.abs(pricePct) < minPricePct || Math.abs(oiPct) < minOiPct) return 'NEUTRAL';
  if (oiPct > 0) return pricePct > 0 ? 'LONG_BUILDUP' : 'SHORT_BUILDUP';
  return pricePct > 0 ? 'SHORT_COVERING' : 'LONG_UNWINDING';
}

export interface ChainAnalytics {
  readonly spot: number;
  readonly atmStrike: number;
  readonly pcrOi: number;
  readonly pcrVolume: number;
  /** Strike at which option writers' aggregate payout is smallest. */
  readonly maxPain: number;
  /** Strike at/above ATM with the most call OI — overhead resistance. */
  readonly callWall: number;
  /** Strike at/below ATM with the most put OI — support beneath. */
  readonly putWall: number;
  readonly atmIv: number | null;
  /** OTM put IV minus OTM call IV, in IV points. Positive = downside fear. */
  readonly ivSkew: number | null;
  readonly straddle: number | null;
  /** ATM straddle as % of spot: the market's priced-in move to expiry. */
  readonly expectedMovePct: number | null;
  readonly callBuildup: Buildup;
  readonly putBuildup: Buildup;
  readonly bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  /** -100..100. A confluence input, not a signal on its own. */
  readonly biasScore: number;
  readonly notes: readonly string[];
  readonly updatedAt: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const mean = (xs: readonly number[]): number | null => (xs.length ? sum(xs) / xs.length : null);
const round = (x: number, dp = 2): number => Math.round(x * 10 ** dp) / 10 ** dp;

function maxPainStrike(rows: readonly ChainRow[]): number {
  let best = rows[0]!.strike;
  let bestPayout = Infinity;
  for (const k of rows) {
    let payout = 0;
    for (const r of rows) {
      payout += (r.call?.oi ?? 0) * Math.max(0, k.strike - r.strike);
      payout += (r.put?.oi ?? 0) * Math.max(0, r.strike - k.strike);
    }
    if (payout < bestPayout) {
      bestPayout = payout;
      best = k.strike;
    }
  }
  return best;
}

function sideBuildup(quotes: readonly OptionQuote[]): Buildup {
  const prevOi = sum(quotes.map((q) => q.prevOi));
  const oiPct = prevOi > 0 ? ((sum(quotes.map((q) => q.oi)) - prevOi) / prevOi) * 100 : 0;
  const pricePct = mean(quotes
    .filter((q) => q.ltp !== null && q.closePrice !== null)
    .map((q) => ((q.ltp! - q.closePrice!) / q.closePrice!) * 100)) ?? 0;
  return classifyBuildup(pricePct, oiPct);
}

const CALL_BUILDUP_SCORE: Record<Buildup, number> = {
  SHORT_BUILDUP: -20, LONG_UNWINDING: -10, NEUTRAL: 0, LONG_BUILDUP: 15, SHORT_COVERING: 20,
};
const PUT_BUILDUP_SCORE: Record<Buildup, number> = {
  SHORT_BUILDUP: 20, LONG_UNWINDING: 10, NEUTRAL: 0, LONG_BUILDUP: -15, SHORT_COVERING: -20,
};

/**
 * Read the positioning in an option chain.
 *
 * Everything here is a well-known, transparent heuristic, weighted modestly and
 * explained in `notes`. It is used to veto or temper a price signal, never to
 * originate a trade: OI-based sentiment is slow, noisy, and widely gamed.
 *
 * `window` = strikes either side of ATM used for buildup and skew, where the
 * liquid, informative positioning sits.
 */
export function analyzeChain(chain: OptionChain, window = 5): ChainAnalytics {
  const { rows, spot } = chain;
  if (rows.length === 0) throw new Error('empty option chain');

  let atmIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (Math.abs(rows[i]!.strike - spot) < Math.abs(rows[atmIdx]!.strike - spot)) atmIdx = i;
  }
  const atm = rows[atmIdx]!;
  const near = rows.slice(Math.max(0, atmIdx - window), atmIdx + window + 1);

  const callOi = sum(rows.map((r) => r.call?.oi ?? 0));
  const putOi = sum(rows.map((r) => r.put?.oi ?? 0));
  const callVol = sum(rows.map((r) => r.call?.volume ?? 0));
  const putVol = sum(rows.map((r) => r.put?.volume ?? 0));
  const pcrOi = callOi > 0 ? putOi / callOi : 0;
  const pcrVolume = callVol > 0 ? putVol / callVol : 0;

  const above = rows.filter((r) => r.strike >= atm.strike);
  const below = rows.filter((r) => r.strike <= atm.strike);
  const callWall = above.reduce((b, r) => ((r.call?.oi ?? 0) > (b.call?.oi ?? 0) ? r : b), above[0]!).strike;
  const putWall = below.reduce((b, r) => ((r.put?.oi ?? 0) > (b.put?.oi ?? 0) ? r : b), below[0]!).strike;
  const maxPain = maxPainStrike(rows);

  const atmIv = mean([atm.call?.iv, atm.put?.iv].filter((x): x is number => x !== null && x !== undefined));
  const otmPutIv = mean(near.filter((r) => r.strike < atm.strike).map((r) => r.put?.iv).filter((x): x is number => x != null));
  const otmCallIv = mean(near.filter((r) => r.strike > atm.strike).map((r) => r.call?.iv).filter((x): x is number => x != null));
  const ivSkew = otmPutIv !== null && otmCallIv !== null ? otmPutIv - otmCallIv : null;

  const straddle = atm.call?.ltp != null && atm.put?.ltp != null ? atm.call.ltp + atm.put.ltp : null;
  const expectedMovePct = straddle !== null ? (straddle / spot) * 100 : null;

  const callBuildup = sideBuildup(near.map((r) => r.call).filter((q): q is OptionQuote => q !== null));
  const putBuildup = sideBuildup(near.map((r) => r.put).filter((q): q is OptionQuote => q !== null));

  const notes: string[] = [];
  let score = 0;
  const add = (pts: number, note: string): void => {
    if (pts === 0) return;
    score += pts;
    notes.push(`${pts > 0 ? '+' : ''}${pts} ${note}`);
  };

  if (pcrOi >= 1.3) add(25, `PCR ${pcrOi.toFixed(2)}: heavy put writing (support)`);
  else if (pcrOi >= 1.1) add(12, `PCR ${pcrOi.toFixed(2)}: puts outweigh calls`);
  else if (pcrOi > 0 && pcrOi <= 0.7) add(-25, `PCR ${pcrOi.toFixed(2)}: heavy call writing (resistance)`);
  else if (pcrOi > 0 && pcrOi <= 0.9) add(-12, `PCR ${pcrOi.toFixed(2)}: calls outweigh puts`);

  add(CALL_BUILDUP_SCORE[callBuildup], `calls near ATM: ${callBuildup.toLowerCase().replace('_', ' ')}`);
  add(PUT_BUILDUP_SCORE[putBuildup], `puts near ATM: ${putBuildup.toLowerCase().replace('_', ' ')}`);

  const painGap = ((maxPain - spot) / spot) * 100;
  if (painGap > 0.5) add(10, `spot ${Math.abs(painGap).toFixed(1)}% below max pain ${maxPain}`);
  else if (painGap < -0.5) add(-10, `spot ${Math.abs(painGap).toFixed(1)}% above max pain ${maxPain}`);

  if ((callWall - spot) / spot < 0.003) add(-15, `pressing call wall ${callWall}`);
  if ((spot - putWall) / spot < 0.003) add(15, `sitting on put wall ${putWall}`);

  const biasScore = Math.max(-100, Math.min(100, score));
  return {
    spot,
    atmStrike: atm.strike,
    pcrOi: round(pcrOi),
    pcrVolume: round(pcrVolume),
    maxPain,
    callWall,
    putWall,
    atmIv: atmIv !== null ? round(atmIv) : null,
    ivSkew: ivSkew !== null ? round(ivSkew) : null,
    straddle: straddle !== null ? round(straddle) : null,
    expectedMovePct: expectedMovePct !== null ? round(expectedMovePct) : null,
    callBuildup,
    putBuildup,
    bias: biasScore >= 20 ? 'BULLISH' : biasScore <= -20 ? 'BEARISH' : 'NEUTRAL',
    biasScore,
    notes,
    updatedAt: chain.fetchedAt,
  };
}
