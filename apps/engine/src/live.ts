import { z } from 'zod';
import type { Candle, Clock, Mode } from '@tradeforger/core';
import { analyzeHybrid, type HybridSetup, type StrategyVote, type Params } from '@tradeforger/strategy';

export const AutoConfigSchema = z.object({
  /** Master switch for autonomous entries. Analysis runs either way. */
  enabled: z.boolean(),
  /** Whether the engine acts on the top ranked stock from universe scanning or a single user-chosen stock */
  targetMode: z.enum(['ALL_SCANNED', 'SINGLE_STOCK']).default('ALL_SCANNED'),
  /** When targetMode is SINGLE_STOCK, entries are restricted to this symbol */
  targetSymbol: z.string().default('RELIANCE'),
  segments: z.object({
    intraday: z.boolean(),
    swing: z.boolean(),
    fno: z.boolean(),
  }),
  /** Hybrid setup quality (0-100) required before acting. */
  minQuality: z.number().min(40).max(100),
  minRewardRisk: z.number().min(1).max(10),
  /**
   * A setup must hold the same side and lead strategy this long before entry.
   * Analysis reads the still-forming bar every 2 s; without this, a signal that
   * flickers into existence for one tick would be traded.
   */
  confirmSeconds: z.number().int().min(2).max(300),
  /** Strategy ids allowed to trigger entries. Empty = every catalog strategy. */
  strategies: z.array(z.string()).max(50),
  maxEntriesPerDay: z.number().int().min(0).max(50),
});
export type AutoConfig = z.infer<typeof AutoConfigSchema>;

export const DEFAULT_AUTO: AutoConfig = {
  enabled: false,
  targetMode: 'ALL_SCANNED',
  targetSymbol: 'RELIANCE',
  segments: { intraday: true, swing: false, fno: false },
  minQuality: 70,
  minRewardRisk: 1.5,
  confirmSeconds: 6,
  strategies: [],
  maxEntriesPerDay: 5,
};

export type Route = 'EQ_INTRADAY' | 'EQ_SWING' | 'FNO';

export interface LiveSetup extends HybridSetup {
  /** Since when this side + lead strategy has held continuously. */
  readonly stableSince: number;
  readonly stableSeconds: number;
  /** Analysis included the still-forming bar. */
  readonly partialBar: boolean;
  /** What autonomous mode would do with it right now, and what stops it. */
  route: Route | null;
  eligible: boolean;
  blockers: string[];
}

export interface LiveAnalysis {
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly ltp: number | null;
  readonly votes: StrategyVote[];
  readonly setups: LiveSetup[];
  readonly analyzedAt: number;
}

export interface Target {
  readonly instrumentKey: string;
  readonly symbol: string;
  /** Has an F&O desk entry — intraday setups may route to options. */
  readonly fnoUnderlying: boolean;
  /** Only an equity can be bought in the cash segment. */
  readonly cashTradeable: boolean;
}

export interface DecisionContext {
  readonly mode: Mode;
  /** Strategy has a human-APPROVED registry version. */
  readonly approved: (strategyId: string) => boolean;
  readonly entriesToday: number;
}

/**
 * Should autonomous mode act on this setup? Pure, so every rule is testable.
 *
 * Returns ALL blockers, not just the first — the dashboard shows exactly why a
 * good-looking setup is not being traded.
 */
export function decide(
  setup: Omit<LiveSetup, 'route' | 'eligible' | 'blockers'>,
  target: Target,
  cfg: AutoConfig,
  ctx: DecisionContext,
): { route: Route | null; blockers: string[] } {
  const blockers: string[] = [];
  let route: Route | null = null;

  if (setup.style === 'SWING') {
    if (target.cashTradeable && cfg.segments.swing) route = 'EQ_SWING';
    else blockers.push(target.cashTradeable ? 'swing segment off' : 'not cash-tradeable');
  } else if (target.fnoUnderlying && cfg.segments.fno) {
    route = 'FNO';
  } else if (target.cashTradeable && cfg.segments.intraday) {
    route = 'EQ_INTRADAY';
  } else {
    blockers.push(target.fnoUnderlying ? 'F&O segment off' : target.cashTradeable ? 'intraday segment off' : 'not cash-tradeable');
  }

  if (!cfg.enabled) blockers.push('autonomous mode off');
  if (setup.quality < cfg.minQuality) blockers.push(`quality ${setup.quality} < ${cfg.minQuality}`);
  if (setup.rewardRisk < cfg.minRewardRisk) blockers.push(`R:R ${setup.rewardRisk.toFixed(2)} < ${cfg.minRewardRisk}`);
  if (setup.stableSeconds < cfg.confirmSeconds) blockers.push(`stable ${setup.stableSeconds}s < ${cfg.confirmSeconds}s`);
  if (cfg.strategies.length > 0 && !cfg.strategies.includes(setup.primaryStrategyId)) {
    blockers.push(`${setup.primaryStrategyId} not enabled`);
  }
  // Paper is where unproven strategies earn their record; real money only
  // follows a strategy a human approved after it passed validation.
  if (ctx.mode === 'LIVE' && !ctx.approved(setup.primaryStrategyId)) {
    blockers.push(`${setup.primaryStrategyId} has no APPROVED version (required in LIVE)`);
  }
  if (ctx.entriesToday >= cfg.maxEntriesPerDay) blockers.push(`daily entry cap ${cfg.maxEntriesPerDay} reached`);

  return { route, blockers };
}

/** Merge candle arrays by timestamp; later sources win (the live bar beats a stale REST bar). */
export function mergeCandles(...sources: ReadonlyArray<readonly Candle[]>): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const src of sources) for (const c of src) byTs.set(c.ts, c);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export interface CandleSource {
  /** Prior sessions + today's closed 5-min bars, oldest first. */
  intraday(key: string): readonly Candle[];
  /** The still-forming 5-min bar, if any. */
  partial(key: string): Candle | null;
  daily(key: string): readonly Candle[];
  ltp(key: string): number | null;
}

/**
 * Re-analyses a set of instruments every cycle and tracks how long each setup
 * has held. It decides nothing about orders — `decide()` does, and the engine
 * acts — so the analyser can run on the dashboard's focus symbol with
 * autonomous mode off and behave identically.
 */
export class LiveAnalyzer {
  private readonly clock: Clock;
  private readonly src: CandleSource;
  private readonly stability = new Map<string, { sig: string; since: number }>();
  readonly results = new Map<string, LiveAnalysis>();

  constructor(clock: Clock, src: CandleSource) {
    this.clock = clock;
    this.src = src;
  }

  analyze(
    targets: readonly Target[],
    params: Readonly<Record<string, Params>>,
    strategies: readonly string[] | undefined,
    cfg: AutoConfig,
    ctx: DecisionContext,
  ): LiveAnalysis[] {
    const now = this.clock.ms();
    const out: LiveAnalysis[] = [];
    const seen = new Set<string>();

    for (const t of targets) {
      const partial = this.src.partial(t.instrumentKey);
      const intraday = partial ? mergeCandles(this.src.intraday(t.instrumentKey), [partial]) : [...this.src.intraday(t.instrumentKey)];
      const r = analyzeHybrid(
        { instrumentKey: t.instrumentKey, symbol: t.symbol, intraday, daily: this.src.daily(t.instrumentKey), clock: this.clock },
        { params, ...(strategies && strategies.length ? { strategies } : {}) },
      );

      const setups: LiveSetup[] = [];
      for (const s of [r.best.INTRADAY, r.best.SWING]) {
        if (!s) continue;
        const key = `${t.instrumentKey}|${s.style}`;
        seen.add(key);
        const sig = `${s.side}|${s.primaryStrategyId}`;
        const prev = this.stability.get(key);
        const since = prev && prev.sig === sig ? prev.since : now;
        this.stability.set(key, { sig, since });
        const base = {
          ...s,
          stableSince: since,
          stableSeconds: Math.floor((now - since) / 1000),
          partialBar: partial !== null && s.style === 'INTRADAY',
        };
        const d = decide(base, t, cfg, ctx);
        setups.push({ ...base, route: d.route, blockers: d.blockers, eligible: d.route !== null && d.blockers.length === 0 });
      }
      const a: LiveAnalysis = {
        instrumentKey: t.instrumentKey, symbol: t.symbol, ltp: this.src.ltp(t.instrumentKey),
        votes: r.votes, setups, analyzedAt: now,
      };
      this.results.set(t.instrumentKey, a);
      out.push(a);
    }
    // A setup that vanished must start its stability clock from zero if it returns.
    for (const k of this.stability.keys()) {
      if (!seen.has(k) && targets.some((t) => k.startsWith(`${t.instrumentKey}|`))) this.stability.delete(k);
    }
    return out;
  }
}
