import { type Paise, type Side, type Signal, paiseToRupees, rupeesToPaise } from '@tradeforger/core';
import type { ChainAnalytics, OptionChain } from './chain.ts';
import type { DerivativeContract } from './contracts.ts';
import { DEFAULT_STRIKE_PARAMS, pickStrike, type StrikeParams } from './select.ts';

export interface OptionPlanParams {
  readonly strike: StrikeParams;
  /** Never risk more than this share of the premium on one trade. */
  readonly maxPremiumLossPct: number;
  /** A stop tighter than this is inside the premium's own noise. */
  readonly minPremiumLossPct: number;
  readonly minRewardRisk: number;
  /** Buying volatility above this is paying for fear that may not pay out. */
  readonly maxIv: number;
  /** |theta| per day as % of premium. Above this, decay outruns the setup. */
  readonly maxThetaPctPerDay: number;
  /** Chain bias this far against the trade vetoes it outright. */
  readonly vetoBiasScore: number;
  /** Trail the stop at the initial risk distance (exchange-side). */
  readonly trail: boolean;
}

export const DEFAULT_OPTION_PLAN: OptionPlanParams = {
  strike: DEFAULT_STRIKE_PARAMS,
  maxPremiumLossPct: 35,
  minPremiumLossPct: 10,
  minRewardRisk: 1.5,
  maxIv: 60,
  maxThetaPctPerDay: 12,
  vetoBiasScore: 50,
  trail: true,
};

/** A fully specified derivative trade. Prices are the CONTRACT's, not the underlying's. */
export interface FnoPlan {
  readonly contract: DerivativeContract;
  /** Order side. Always BUY for options: this system never writes options. */
  readonly side: Side;
  readonly entry: Paise;
  readonly stopLoss: Paise;
  readonly target: Paise;
  readonly trailingGap: Paise | null;
  readonly delta: number | null;
  readonly iv: number | null;
  readonly thetaPctPerDay: number | null;
  readonly spreadPct: number | null;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
}

export type PlanResult = { ok: true; plan: FnoPlan } | { ok: false; reasons: string[] };

const floorTick = (x: number, tick: number): number => Math.floor(x / tick + 1e-9) * tick;
const ceilTick = (x: number, tick: number): number => Math.ceil(x / tick - 1e-9) * tick;
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Turn a directional signal on the underlying into a long CE (bullish) or long
 * PE (bearish).
 *
 * Premium levels come from the underlying's stop/target distances through
 * delta and gamma — premium moves ≈ Δ·m + ½Γ·m² — then the stop is clamped to
 * a band of the premium. Both clamps are about honesty: a 70% premium stop is
 * a different trade from the one the signal described, and a 3% one is noise.
 *
 * Long options only. Maximum loss is the premium paid, so a gap through the
 * stop cannot cost more than the position — the property that makes options
 * the safer way for an autonomous system to express a view. Writing options
 * has unbounded loss and is deliberately not offered.
 */
export function planOption(
  signal: Signal,
  chain: OptionChain,
  analytics: ChainAnalytics,
  resolve: (strike: number, type: 'CE' | 'PE') => DerivativeContract | null,
  p: OptionPlanParams = DEFAULT_OPTION_PLAN,
): PlanResult {
  const long = signal.side === 'BUY';
  const type = long ? 'CE' : 'PE';

  // Vet against chain positioning before doing any work.
  const against = long ? -analytics.biasScore : analytics.biasScore;
  if (against >= p.vetoBiasScore) {
    return { ok: false, reasons: [`option chain strongly ${analytics.bias} (${analytics.biasScore}) against a ${long ? 'bullish' : 'bearish'} signal`] };
  }

  const picked = pickStrike(chain, type, p.strike);
  if (!picked.ok) return { ok: false, reasons: picked.reasons.map((r) => `${type} ${r}`) };
  const { row, quote, delta, spreadPct } = picked.pick;

  const contract = resolve(row.strike, type);
  if (!contract) return { ok: false, reasons: [`no ${type} ${row.strike} contract for ${chain.expiry} in the master`] };
  const tick = contract.tickSize;

  const reasons: string[] = [];
  const flags: string[] = [];

  if (quote.iv !== null && quote.iv > p.maxIv) {
    return { ok: false, reasons: [`IV ${quote.iv.toFixed(1)}% above ${p.maxIv}% ceiling`] };
  }

  const premium = ceilTick(quote.ask ?? quote.ltp!, tick);
  const thetaPct = quote.theta !== null ? (Math.abs(quote.theta) / premium) * 100 : null;
  if (thetaPct !== null && thetaPct > p.maxThetaPctPerDay) {
    return { ok: false, reasons: [`theta ${thetaPct.toFixed(1)}%/day of premium above ${p.maxThetaPctPerDay}%`] };
  }

  const entryU = paiseToRupees(signal.entry);
  const risk = Math.abs(entryU - paiseToRupees(signal.stopLoss));
  const reward = Math.abs(paiseToRupees(signal.target) - entryU);
  // Without greeks, assume ATM-like behaviour rather than refusing outright.
  const d = delta ?? 0.5;
  const g = quote.gamma ?? 0;
  if (delta === null) flags.push('NO_GREEKS');

  const modelStop = premium - d * risk + 0.5 * g * risk * risk;
  const maxStop = premium * (1 - p.minPremiumLossPct / 100);   // tightest allowed
  const minStop = premium * (1 - p.maxPremiumLossPct / 100);   // widest allowed
  const stopLoss = floorTick(Math.min(maxStop, Math.max(minStop, modelStop)), tick);
  if (modelStop < minStop) flags.push('STOP_CLAMPED_TO_MAX_LOSS');

  const target = floorTick(premium + d * reward + 0.5 * g * reward * reward, tick);
  const premiumRisk = premium - stopLoss;
  if (stopLoss <= 0 || premiumRisk <= 0) {
    return { ok: false, reasons: ['premium too small to place a stop below it'] };
  }
  const rr = (target - premium) / premiumRisk;
  if (rr < p.minRewardRisk) {
    return { ok: false, reasons: [`premium reward:risk ${rr.toFixed(2)} below ${p.minRewardRisk}`] };
  }

  reasons.push(
    `${type} ${row.strike} ${chain.expiry}: Δ ${delta !== null ? delta.toFixed(2) : 'n/a'}, premium ₹${premium.toFixed(2)}`,
    `premium SL ₹${stopLoss.toFixed(2)} / target ₹${target.toFixed(2)} (R:R ${rr.toFixed(2)})`,
  );

  // Walls between here and the target cap the move the premium needs.
  const spotTarget = chain.spot + (long ? reward : -reward);
  if (long && analytics.callWall > chain.spot && analytics.callWall < spotTarget) {
    flags.push(`CALL_WALL_${analytics.callWall}_BEFORE_TARGET`);
  }
  if (!long && analytics.putWall < chain.spot && analytics.putWall > spotTarget) {
    flags.push(`PUT_WALL_${analytics.putWall}_BEFORE_TARGET`);
  }

  let confidence = signal.confidence;
  if (against <= -20) {
    confidence += 10;
    reasons.push(`chain bias ${analytics.bias} (${analytics.biasScore}) agrees`);
  } else if (against >= 20) {
    confidence -= 10;
    flags.push(`CHAIN_BIAS_${analytics.bias}`);
  }
  confidence -= 5 * flags.filter((f) => f !== 'NO_GREEKS').length;

  const trailingGap = p.trail ? rupeesToPaise(ceilTick(premiumRisk, tick)) : null;

  return {
    ok: true,
    plan: {
      contract,
      side: 'BUY',
      entry: rupeesToPaise(premium),
      stopLoss: rupeesToPaise(stopLoss),
      target: rupeesToPaise(target),
      trailingGap,
      delta: delta !== null ? r2(delta) : null,
      iv: quote.iv,
      thetaPctPerDay: thetaPct !== null ? r2(thetaPct) : null,
      spreadPct: spreadPct !== null ? r2(spreadPct) : null,
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      reasons,
      flags,
    },
  };
}

/**
 * A futures trade carrying the signal's own levels across the basis.
 *
 * When the signal was computed on the future itself (index underlyings), the
 * basis is zero. For a stock signal read off the cash market, every level is
 * shifted by (future − spot) so the stop and target keep their distances.
 * Unlike a long option, a futures loss is NOT capped by the stop: a gap goes
 * straight through it. That is why futures are opt-in.
 */
export function planFuture(signal: Signal, contract: DerivativeContract, futureLtp: number, signalLtp: number): PlanResult {
  const basis = futureLtp - signalLtp;
  const tick = contract.tickSize;
  const shift = (p: Paise): Paise => rupeesToPaise(floorTick(paiseToRupees(p) + basis, tick));
  return {
    ok: true,
    plan: {
      contract,
      side: signal.side,
      entry: shift(signal.entry),
      stopLoss: shift(signal.stopLoss),
      target: shift(signal.target),
      trailingGap: null,
      delta: 1,
      iv: null,
      thetaPctPerDay: null,
      spreadPct: null,
      confidence: signal.confidence,
      reasons: [`${contract.tradingSymbol}${basis !== 0 ? `, basis ${basis >= 0 ? '+' : ''}${basis.toFixed(2)}` : ''}`],
      flags: ['UNCAPPED_GAP_RISK'],
    },
  };
}
