import { type Candle, type Clock, type Side, type Signal, paiseToRupees } from '@tradeforger/core';
import { STRATEGY_CATALOG, type Params, type StrategyDefinition } from './catalog.ts';

export interface StrategyVote {
  readonly strategyId: string;
  readonly name: string;
  readonly style: 'INTRADAY' | 'SWING';
  /** null = the strategy sees no trade. */
  readonly side: Side | null;
  readonly confidence: number;
  readonly signal: Signal | null;
  readonly reasons: readonly string[];
}

export interface HybridSetup {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly style: 'INTRADAY' | 'SWING';
  readonly side: Side;
  /** Rupees, from the lead strategy's signal. */
  readonly entry: number;
  readonly stopLoss: number;
  readonly target: number;
  readonly rewardRisk: number;
  /** 0-100. See `setupQuality`. */
  readonly quality: number;
  readonly primaryStrategyId: string;
  readonly agreeing: string[];
  readonly conflicting: string[];
  readonly votes: StrategyVote[];
  readonly reasons: string[];
  readonly generatedAt: number;
}

export interface HybridInput {
  readonly instrumentKey: string;
  readonly symbol: string;
  /** 5-minute bars, prior sessions allowed for warmup, oldest first. */
  readonly intraday: readonly Candle[];
  /** Daily bars, oldest first. */
  readonly daily: readonly Candle[];
  readonly clock: Clock;
}

export interface HybridOptions {
  /** Catalog ids to run. Default: every strategy. */
  readonly strategies?: readonly string[];
  /** Per-strategy params (e.g. the registry's approved versions). Default: each definition's defaults. */
  readonly params?: Readonly<Record<string, Params>>;
}

/** Each additional strategy on the same side adds this, up to AGREE_CAP. */
export const AGREE_BONUS = 8;
export const AGREE_CAP = 24;
/** Each opposing strategy costs this much, scaled by its confidence relative to the lead. */
export const CONFLICT_PENALTY = 20;
/** An opposing signal within this many points of the lead caps quality at COIN_FLIP_CAP. */
export const COIN_FLIP_MARGIN = 10;
export const COIN_FLIP_CAP = 40;
/** Quality points per unit of reward:risk away from 2:1, clamped to ±RR_ADJ_CAP. */
export const RR_ADJ_PER_UNIT = 5;
export const RR_ADJ_CAP = 10;
/**
 * Stop distance as % of price below which a setup is untradeable: round-trip
 * costs, spread and tick noise are of the same size as the risk, so the
 * position size balloons and the edge is gone. Such setups are capped at
 * UNTRADEABLE_CAP whatever the strategies say.
 */
export const MIN_RISK_PCT: Readonly<Record<'INTRADAY' | 'SWING', number>> = { INTRADAY: 0.2, SWING: 0.75 };
export const UNTRADEABLE_CAP = 30;

const rr = (s: Signal): number => {
  const risk = Math.abs(s.entry - s.stopLoss);
  return risk > 0 ? Math.abs(s.target - s.entry) / risk : 0;
};

/**
 * Setup quality for one style.
 *
 *   quality = lead.confidence
 *           + min(AGREE_CAP, AGREE_BONUS × other strategies on the same side)
 *           − Σ CONFLICT_PENALTY × (opposing.confidence / lead.confidence)
 *           + clamp((R:R − 2) × RR_ADJ_PER_UNIT, ±RR_ADJ_CAP)
 *
 * clamped to 0–100, then capped at COIN_FLIP_CAP if any opposing strategy is
 * within COIN_FLIP_MARGIN of the lead's confidence. Independent strategies
 * agreeing is evidence; comparably strong strategies disagreeing means the
 * market is not telling us anything, and no setup beats a coin flip.
 */
export function setupQuality(lead: Signal, agreeing: readonly Signal[], opposing: readonly Signal[]): number {
  let q = lead.confidence;
  q += Math.min(AGREE_CAP, AGREE_BONUS * agreeing.length);
  for (const o of opposing) q -= CONFLICT_PENALTY * (o.confidence / Math.max(1, lead.confidence));
  q += Math.max(-RR_ADJ_CAP, Math.min(RR_ADJ_CAP, (rr(lead) - 2) * RR_ADJ_PER_UNIT));
  q = Math.max(0, Math.min(100, Math.round(q)));
  if (opposing.some((o) => o.confidence >= lead.confidence - COIN_FLIP_MARGIN)) q = Math.min(q, COIN_FLIP_CAP);
  return q;
}

/**
 * Run several independent strategies on one instrument and combine them.
 *
 * Every strategy votes on its own timeframe (5-min or daily). Per style, the
 * highest-confidence signal leads; the others either corroborate it or argue
 * against it. Pure and deterministic: same candles, same clock, same answer —
 * which is what lets the 2-second live loop, the scanner and the tests all
 * share it.
 */
export function analyzeHybrid(
  input: HybridInput,
  opts: HybridOptions = {},
): { votes: StrategyVote[]; best: { INTRADAY: HybridSetup | null; SWING: HybridSetup | null } } {
  const defs: StrategyDefinition[] = opts.strategies && opts.strategies.length > 0
    ? STRATEGY_CATALOG.filter((d) => opts.strategies!.includes(d.id))
    : STRATEGY_CATALOG;

  const votes: StrategyVote[] = defs.map((def) => {
    const candles = def.timeframe === '1d' ? input.daily : input.intraday;
    let signal: Signal | null = null;
    if (candles.length > 0) {
      signal = def.create(opts.params?.[def.id]).evaluate({
        instrumentKey: input.instrumentKey,
        symbol: input.symbol,
        candles,
        higherTf: def.timeframe === '5m' ? input.daily : [],
        clock: input.clock,
      });
    }
    return {
      strategyId: def.id,
      name: def.name,
      style: def.style,
      side: signal?.side ?? null,
      confidence: signal?.confidence ?? 0,
      signal,
      reasons: signal?.reasons ?? [],
    };
  });

  const bestFor = (style: 'INTRADAY' | 'SWING'): HybridSetup | null => {
    const firing = votes.filter((v) => v.style === style && v.signal !== null);
    if (firing.length === 0) return null;
    const lead = firing.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const ls = lead.signal!;
    const agreeing = firing.filter((v) => v !== lead && v.side === lead.side);
    const opposing = firing.filter((v) => v.side !== lead.side);
    const riskPct = (Math.abs(ls.entry - ls.stopLoss) / ls.entry) * 100;
    const tooTight = riskPct < MIN_RISK_PCT[style];
    let quality = setupQuality(ls, agreeing.map((v) => v.signal!), opposing.map((v) => v.signal!));
    if (tooTight) quality = Math.min(quality, UNTRADEABLE_CAP);
    return {
      instrumentKey: input.instrumentKey,
      symbol: input.symbol,
      style,
      side: ls.side,
      entry: paiseToRupees(ls.entry),
      stopLoss: paiseToRupees(ls.stopLoss),
      target: paiseToRupees(ls.target),
      rewardRisk: Math.round(rr(ls) * 100) / 100,
      quality,
      primaryStrategyId: lead.strategyId,
      agreeing: agreeing.map((v) => v.strategyId),
      conflicting: opposing.map((v) => v.strategyId),
      votes: votes.filter((v) => v.style === style),
      reasons: [
        `${lead.name}: ${ls.reasons.join('; ')}`,
        ...agreeing.map((v) => `confirmed by ${v.name}`),
        ...opposing.map((v) => `contradicted by ${v.name} (${v.side} ${v.confidence})`),
        ...(tooTight ? [`stop only ${riskPct.toFixed(2)}% from entry — inside costs and noise (min ${MIN_RISK_PCT[style]}%)`] : []),
      ],
      generatedAt: input.clock.ms(),
    };
  };

  return { votes, best: { INTRADAY: bestFor('INTRADAY'), SWING: bestFor('SWING') } };
}
