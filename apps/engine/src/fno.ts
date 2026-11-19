import { type Clock, type Signal, type Side, istDateKey, paiseToRupees } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import {
  FnoUniverse, fetchMaster, chainFromUpstox, analyzeChain, pickExpiry, planOption, planFuture,
  type DerivativeContract, type OptionChain, type ChainAnalytics, type FnoPlan,
  type OptionPlanParams, type PlanResult,
} from '@tradeforger/fno';

export interface FnoSettings {
  readonly symbols: readonly string[];
  readonly instrument: 'OPTIONS' | 'FUTURES';
  readonly minDte: number;
  readonly plan: OptionPlanParams;
  readonly refreshMs: number;
}

export interface UnderlyingState {
  readonly symbol: string;
  underlyingKey: string;
  /** Instrument whose candles drive signals. Index candles carry no volume, so
   *  for an index this is the near-month future, which does. */
  signalKey: string;
  future: DerivativeContract | null;
  expiry: string | null;
  lotSize: number | null;
  chain: OptionChain | null;
  analytics: ChainAnalytics | null;
  error: string | null;
}

export type PlanStatus = 'ANALYSIS' | 'PLANNED' | 'PLACED' | 'REJECTED';

/** The JSON the dashboard renders for a setup. Rupees, not paise. */
export interface FnoPlanView {
  readonly id: string;
  readonly symbol: string;
  readonly contract: {
    instrumentKey: string; tradingSymbol: string; instrumentType: 'CE' | 'PE' | 'FUT';
    strike: number | null; expiry: string; lotSize: number;
  } | null;
  readonly side: Side;
  lots: number;
  quantity: number;
  readonly premium: { entry: number; stopLoss: number; target: number; trailingGap: number | null } | null;
  readonly underlying: { side: Side; entry: number; stopLoss: number; target: number };
  readonly delta: number | null;
  readonly iv: number | null;
  readonly spreadPct: number | null;
  costRupees: number;
  maxLossRupees: number;
  rewardRupees: number;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly flags: readonly string[];
  status: PlanStatus;
  rejectReason: string | null;
  readonly createdAt: number;
}

export type DeskPlan = { ok: true; plan: FnoPlan; volume: number } | { ok: false; reasons: string[] };

/**
 * Live F&O analysis and planning for a small set of underlyings.
 *
 * Owns the instrument master, the option-chain cache and the recent-plans
 * journal. It never places orders — it hands a fully-specified plan back to the
 * engine, which runs it through the same breakers, sizing and Trader as equity.
 */
export class FnoDesk {
  universe: FnoUniverse | null = null;
  readonly states = new Map<string, UnderlyingState>();
  readonly plans: FnoPlanView[] = [];
  private readonly client: UpstoxClient;
  private readonly clock: Clock;
  private readonly settings: FnoSettings;
  private readonly ltpOf: (key: string) => number | null;
  private loadedDay = '';
  private seq = 0;

  constructor(opts: {
    client: UpstoxClient; clock: Clock; settings: FnoSettings; ltpOf: (key: string) => number | null;
  }) {
    this.client = opts.client;
    this.clock = opts.clock;
    this.settings = opts.settings;
    this.ltpOf = opts.ltpOf;
  }

  private today(): string {
    return istDateKey(this.clock.now());
  }

  /** Load the master and resolve every underlying. Re-run daily: contracts expire. */
  async init(contracts?: readonly DerivativeContract[]): Promise<void> {
    this.universe = new FnoUniverse(contracts ?? await fetchMaster());
    this.loadedDay = this.today();
    for (const symbol of this.settings.symbols) this.resolve(symbol);
  }

  needsReload(): boolean {
    return this.loadedDay !== this.today();
  }

  private resolve(symbol: string): void {
    const u = this.universe!;
    const today = this.today();
    const prev = this.states.get(symbol);
    const underlyingKey = u.underlyingKey(symbol);
    const future = u.nearFuture(symbol, today);
    if (!underlyingKey || !future) {
      this.states.set(symbol, {
        symbol, underlyingKey: underlyingKey ?? '', signalKey: '', future: null,
        expiry: null, lotSize: null, chain: null, analytics: null,
        error: `${symbol} has no tradeable F&O contracts in today's master`,
      });
      return;
    }
    const expiry = pickExpiry(u.expiries(symbol, 'OPTION', today), today, this.settings.minDte);
    this.states.set(symbol, {
      symbol,
      underlyingKey,
      signalKey: underlyingKey.startsWith('NSE_INDEX|') ? future.instrumentKey : underlyingKey,
      future,
      expiry,
      lotSize: future.lotSize,
      chain: prev?.chain ?? null,
      analytics: prev?.analytics ?? null,
      error: expiry ? null : `no option expiry with ≥${this.settings.minDte} days left`,
    });
  }

  /** Every key the market feed must carry for the desk to work. */
  feedKeys(): string[] {
    const keys = new Set<string>();
    for (const s of this.states.values()) {
      if (s.signalKey) keys.add(s.signalKey);
      if (s.underlyingKey) keys.add(s.underlyingKey);
      if (s.future) keys.add(s.future.instrumentKey);
    }
    return [...keys];
  }

  symbolForSignalKey(key: string): string | null {
    for (const s of this.states.values()) if (s.signalKey === key) return s.symbol;
    return null;
  }

  async refresh(symbol: string, maxAgeMs = this.settings.refreshMs): Promise<UnderlyingState | null> {
    const s = this.states.get(symbol);
    if (!s || !s.expiry || !s.underlyingKey) return s ?? null;
    if (s.chain && this.clock.ms() - s.chain.fetchedAt < maxAgeMs) return s;

    const r = await this.client.optionChain(s.underlyingKey, s.expiry);
    if (!r.ok) {
      s.error = `option chain: ${r.error.message}`;
      return s;
    }
    const chain = chainFromUpstox(r.value, this.clock.ms());
    if (!chain || chain.rows.length === 0) {
      s.error = 'option chain empty (market closed or expiry has no strikes)';
      return s;
    }
    s.chain = chain;
    s.analytics = analyzeChain(chain);
    s.error = null;
    return s;
  }

  async refreshAll(): Promise<void> {
    for (const symbol of this.states.keys()) await this.refresh(symbol);
  }

  /** Build a plan from a signal on the underlying. Chains older than 10s are refetched. */
  async plan(symbol: string, signal: Signal): Promise<DeskPlan> {
    const s = await this.refresh(symbol, 10_000);
    if (!s) return { ok: false, reasons: [`${symbol} is not on the F&O desk`] };
    if (s.error) return { ok: false, reasons: [s.error] };

    if (this.settings.instrument === 'FUTURES') {
      if (!s.future) return { ok: false, reasons: ['no near-month future'] };
      const futLtp = this.ltpOf(s.future.instrumentKey);
      const sigLtp = this.ltpOf(s.signalKey);
      if (futLtp === null || sigLtp === null) return { ok: false, reasons: ['no live price for the future'] };
      const r: PlanResult = planFuture(signal, s.future, futLtp, sigLtp);
      return r.ok ? { ok: true, plan: r.plan, volume: 0 } : r;
    }

    if (!s.chain || !s.analytics || !s.expiry) return { ok: false, reasons: ['no option chain yet'] };
    const u = this.universe!;
    const expiry = s.expiry;
    const r = planOption(signal, s.chain, s.analytics, (strike, type) => u.option(symbol, expiry, strike, type), this.settings.plan);
    if (!r.ok) return r;
    const row = s.chain.rows.find((x) => x.strike === r.plan.contract.strike);
    const leg = r.plan.contract.instrumentType === 'CE' ? row?.call : row?.put;
    return { ok: true, plan: r.plan, volume: leg?.volume ?? 0 };
  }

  view(
    symbol: string, signal: Signal, plan: FnoPlan | null, status: PlanStatus,
    rejectReason: string | null, lots = 0,
  ): FnoPlanView {
    const c = plan?.contract;
    const qty = c ? lots * c.lotSize : 0;
    const perUnitRisk = plan ? Math.abs(plan.entry - plan.stopLoss) : 0;
    const perUnitReward = plan ? Math.abs(plan.target - plan.entry) : 0;
    this.seq += 1;
    return {
      id: `fno-${this.clock.ms()}-${this.seq}`,
      symbol,
      contract: c ? {
        instrumentKey: c.instrumentKey, tradingSymbol: c.tradingSymbol, instrumentType: c.instrumentType,
        strike: c.strike, expiry: c.expiry, lotSize: c.lotSize,
      } : null,
      side: plan?.side ?? signal.side,
      lots,
      quantity: qty,
      premium: plan ? {
        entry: paiseToRupees(plan.entry), stopLoss: paiseToRupees(plan.stopLoss),
        target: paiseToRupees(plan.target),
        trailingGap: plan.trailingGap !== null ? paiseToRupees(plan.trailingGap) : null,
      } : null,
      underlying: {
        side: signal.side, entry: paiseToRupees(signal.entry),
        stopLoss: paiseToRupees(signal.stopLoss), target: paiseToRupees(signal.target),
      },
      delta: plan?.delta ?? null,
      iv: plan?.iv ?? null,
      spreadPct: plan?.spreadPct ?? null,
      costRupees: plan ? paiseToRupees((plan.entry * qty) as never) : 0,
      maxLossRupees: paiseToRupees((perUnitRisk * qty) as never),
      rewardRupees: paiseToRupees((perUnitReward * qty) as never),
      confidence: plan?.confidence ?? signal.confidence,
      reasons: plan ? [...signal.reasons, ...plan.reasons] : [...signal.reasons],
      flags: plan ? [...plan.flags] : [],
      status,
      rejectReason,
      createdAt: this.clock.ms(),
    };
  }

  record(v: FnoPlanView): FnoPlanView {
    this.plans.unshift(v);
    if (this.plans.length > 30) this.plans.pop();
    return v;
  }

  /** Dashboard shape for GET /state. */
  snapshot(enabled: boolean): unknown {
    return {
      enabled,
      instrument: this.settings.instrument,
      underlyings: [...this.states.values()].map((s) => ({
        symbol: s.symbol,
        underlyingKey: s.underlyingKey,
        signalKey: s.signalKey,
        spot: this.ltpOf(s.underlyingKey) ?? s.chain?.spot ?? null,
        expiry: s.expiry,
        lotSize: s.lotSize,
        error: s.error,
        analytics: s.analytics,
      })),
      plans: this.plans,
    };
  }
}
