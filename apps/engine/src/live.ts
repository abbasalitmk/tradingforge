import { z } from 'zod';
import type { Candle, Clock, Mode, Side } from '@tradeforger/core';
import { analyzeHybrid, type HybridSetup, type StrategyVote, type Params } from '@tradeforger/strategy';

export const AutoConfigSchema = z.object({
  /** Master switch for autonomous entries. Analysis runs either way. */
  enabled: z.boolean(),
  /** Whether the engine acts on the top ranked stock from universe scanning or a single user-chosen stock */
  targetMode: z.enum(['ALL_SCANNED', 'SINGLE_STOCK']).default('ALL_SCANNED'),
  /** When targetMode is SINGLE_STOCK, entries are restricted to this symbol */
  targetSymbol: z.string().default('RELIANCE'),
  /** Price filter: minimum stock entry price in Rupees (0 = no min) */
  minPrice: z.number().min(0).default(0),
  /** Price filter: maximum stock entry price in Rupees (500000 = no max) */
  maxPrice: z.number().min(0).default(500000),
  segments: z.object({
    intraday: z.boolean(),
    swing: z.boolean(),
    fno: z.boolean(),
  }),
  /** Hybrid setup quality (0-100) required before acting. */
  minQuality: z.number().min(40).max(100),
  minRewardRisk: z.number().min(1).max(10),
  /**
   * Reward:risk once round-trip charges are counted (reward minus costs over
   * risk plus costs). Charges are ~0.15% of turnover whatever the size, so on a
   * tight intraday stop they cost a quarter of R or more.
   */
  minNetRewardRisk: z.number().min(0.5).max(10).default(1.25),
  /**
   * A setup must hold the same side and lead strategy this long before entry.
   * Analysis reads the still-forming bar every 2 s; without this, a signal that
   * flickers into existence for one tick would be traded.
   */
  confirmSeconds: z.number().int().min(2).max(300),
  /** Strategy ids allowed to trigger entries. Empty = every catalog strategy. */
  strategies: z.array(z.string()).max(50),
  maxEntriesPerDay: z.number().int().min(0).max(50),
  /** Portfolio limits: open positions in total, led by any one strategy, and on one side. */
  maxOpenPositions: z.number().int().min(1).max(50).default(5),
  maxPerStrategy: z.number().int().min(1).max(50).default(2),
  maxSameSide: z.number().int().min(1).max(50).default(3),
  /**
   * Trail the stop at the initial risk distance once the trade moves in our
   * favour (exchange-side, via the GTT's trailing_gap). Off by default: it
   * changes the exit profile the strategies were validated with.
   */
  trailStop: z.boolean().default(false),
  /**
   * Stop a strategy leading new entries once its own recorded trades in this
   * mode show negative expectancy after costs over a meaningful sample.
   */
  pauseLosingStrategies: z.boolean().default(true),
  /**
   * A strategy whose active parameters FAILED validation (walk-forward,
   * out-of-sample, cost stress) does not lead entries in any mode — paper
   * included. Paper exists to give unproven strategies a record, not to keep
   * trading ones history has already shown lose.
   */
  skipFailedStrategies: z.boolean().default(true),
  /**
   * Which views autonomous mode trades: BUY (long only), SELL (short only) or
   * BOTH. A bearish F&O setup buys a put under options, or sells a future. A
   * swing SELL is never automated whatever this says — on a delivery product
   * it sells shares out of the demat account.
   */
  tradeSide: z.enum(['BUY', 'SELL', 'BOTH']).default('BUY'),
  /**
   * Re-pick the day's strongest liquid stocks from the whole NSE market every
   * few minutes and analyse them alongside the default universe and the
   * stocks added by hand.
   */
  autoUniverse: z.boolean().default(true),
  autoUniverseSize: z.number().int().min(1).max(30).default(15),
  /** Day turnover floor for an auto-picked stock, ₹ crore. */
  autoUniverseMinTurnoverCr: z.number().min(1).max(5000).default(25),
});
export type AutoConfig = z.infer<typeof AutoConfigSchema>;

export const DEFAULT_AUTO: AutoConfig = {
  enabled: false,
  targetMode: 'ALL_SCANNED',
  targetSymbol: 'RELIANCE',
  minPrice: 0,
  maxPrice: 500000,
  segments: { intraday: true, swing: false, fno: false },
  minQuality: 70,
  minRewardRisk: 1.5,
  minNetRewardRisk: 1.25,
  confirmSeconds: 6,
  strategies: [],
  maxEntriesPerDay: 5,
  maxOpenPositions: 5,
  maxPerStrategy: 2,
  maxSameSide: 3,
  trailStop: false,
  pauseLosingStrategies: true,
  skipFailedStrategies: true,
  tradeSide: 'BUY',
  autoUniverse: true,
  autoUniverseSize: 15,
  autoUniverseMinTurnoverCr: 25,
};

/** Trades a strategy needs on record before its expectancy is trusted enough to pause it. */
export const MIN_TRADES_TO_JUDGE = 20;

/** A strategy's own recorded result in the current mode, operator exits excluded. */
export interface StrategyRecord {
  readonly trades: number;
  readonly expectancyR: number;
}

/**
 * The dashboard's strategy mode, expressed as the cash segments the live loop
 * may enter. `decide()` reads only segments, so a mode that is not mapped here
 * would change the label on the dashboard and nothing about what trades.
 */
export function segmentsForMode(
  mode: 'INTRADAY' | 'SWING' | 'BOTH',
  current: AutoConfig['segments'],
): AutoConfig['segments'] {
  return { ...current, intraday: mode !== 'SWING', swing: mode !== 'INTRADAY' };
}

/** Inverse of `segmentsForMode`, or null when neither cash segment is on. */
export function modeForSegments(s: AutoConfig['segments']): 'INTRADAY' | 'SWING' | 'BOTH' | null {
  if (s.intraday && s.swing) return 'BOTH';
  if (s.intraday) return 'INTRADAY';
  if (s.swing) return 'SWING';
  return null;
}

export type Route = 'EQ_INTRADAY' | 'EQ_SWING' | 'FNO';

export interface LiveSetup extends HybridSetup {
  /** Since when this side + lead strategy has held continuously. */
  readonly stableSince: number;
  readonly stableSeconds: number;
  /** Analysis included the still-forming bar. */
  readonly partialBar: boolean;
  /** Set when the live price has already made the setup untradeable. */
  readonly invalidReason: string | null;
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
  /** What is open right now, for the portfolio limits. */
  readonly open?: {
    readonly total: number;
    readonly byStrategy: Readonly<Record<string, number>>;
    readonly bySide: Readonly<Record<'BUY' | 'SELL', number>>;
  };
  /** Recorded performance of a strategy in this mode, if any. */
  readonly record?: (strategyId: string) => StrategyRecord | null;
  /** Validation verdict on the parameters in use; null = never validated. */
  readonly verdict?: (strategyId: string) => { status: 'APPROVED' | 'VALIDATED' | 'REJECTED'; oosExpectancyR: number | null } | null;
}

/** Where a setup of this style on this target would be entered, or why it cannot be. */
export function routeFor(
  style: 'INTRADAY' | 'SWING',
  target: Target,
  cfg: AutoConfig,
): { route: Route | null; blocker: string | null } {
  if (style === 'SWING') {
    return target.cashTradeable && cfg.segments.swing
      ? { route: 'EQ_SWING', blocker: null }
      : { route: null, blocker: target.cashTradeable ? 'swing segment off' : 'not cash-tradeable' };
  }
  if (target.fnoUnderlying && cfg.segments.fno) return { route: 'FNO', blocker: null };
  if (target.cashTradeable && cfg.segments.intraday) return { route: 'EQ_INTRADAY', blocker: null };
  return { route: null, blocker: target.fnoUnderlying ? 'F&O segment off' : target.cashTradeable ? 'intraday segment off' : 'not cash-tradeable' };
}

/** The direction filter: does it let this side trade? */
export const sideAllowed = (side: Side, tradeSide: AutoConfig['tradeSide']): boolean =>
  tradeSide === 'BOTH' || tradeSide === side;

/** Why this side cannot be entered on this route, or null. */
export function sideBlocker(side: Side, route: Route | null, cfg: AutoConfig): string | null {
  if (!sideAllowed(side, cfg.tradeSide)) return `direction filter is ${cfg.tradeSide === 'BUY' ? 'buy only' : 'short only'}`;
  if (side === 'SELL' && route === 'EQ_SWING') return 'swing SELL would sell delivery holdings — never automated';
  return null;
}

/** Blockers that belong to the strategy itself, whatever the instrument. */
function strategyBlockers(strategyId: string, cfg: AutoConfig, ctx: DecisionContext): string[] {
  const blockers: string[] = [];
  if (cfg.strategies.length > 0 && !cfg.strategies.includes(strategyId)) {
    blockers.push(`${strategyId} not enabled`);
  }
  // Paper is where unproven strategies earn their record; real money only
  // follows a strategy a human approved after it passed validation.
  if (ctx.mode === 'LIVE' && !ctx.approved(strategyId)) {
    blockers.push(`${strategyId} has no APPROVED version (required in LIVE)`);
  }
  const verdict = ctx.verdict?.(strategyId) ?? null;
  if (cfg.skipFailedStrategies && verdict?.status === 'REJECTED') {
    const oos = verdict.oosExpectancyR;
    blockers.push(`${strategyId} failed validation${oos !== null ? ` (${oos.toFixed(2)}R out-of-sample)` : ''} — improve it in Strategy Lab`);
  }
  const rec = ctx.record?.(strategyId) ?? null;
  if (cfg.pauseLosingStrategies && rec && rec.trades >= MIN_TRADES_TO_JUDGE && rec.expectancyR < 0) {
    blockers.push(`${strategyId} paused: ${rec.expectancyR.toFixed(2)}R expectancy over its last ${rec.trades} ${ctx.mode === 'LIVE' ? 'live' : 'paper'} trades`);
  }
  return blockers;
}

/**
 * May this vote lead a setup on this target? Only one that `decide()` would
 * not block for who it is or which way it points — so a tradeable signal is
 * never hidden behind a stronger one that could not be traded.
 */
export function canLead(vote: StrategyVote, target: Target, cfg: AutoConfig, ctx: DecisionContext): boolean {
  if (!vote.side) return false;
  if (sideBlocker(vote.side, routeFor(vote.style, target, cfg).route, cfg)) return false;
  return strategyBlockers(vote.strategyId, cfg, ctx).length === 0;
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
  const { route, blocker } = routeFor(setup.style, target, cfg);
  if (blocker) blockers.push(blocker);
  const side = sideBlocker(setup.side, route, cfg);
  if (side) blockers.push(side);

  if (setup.invalidReason) blockers.push(setup.invalidReason);
  if (!cfg.enabled) blockers.push('autonomous mode off');
  if (setup.quality < cfg.minQuality) blockers.push(`quality ${setup.quality} < ${cfg.minQuality}`);
  if (setup.rewardRisk < cfg.minRewardRisk) blockers.push(`R:R ${setup.rewardRisk.toFixed(2)} < ${cfg.minRewardRisk}`);
  if (setup.stableSeconds < cfg.confirmSeconds) blockers.push(`stable ${setup.stableSeconds}s < ${cfg.confirmSeconds}s`);
  if (cfg.minPrice > 0 && setup.entry < cfg.minPrice) {
    blockers.push(`price ₹${setup.entry.toFixed(2)} < min ₹${cfg.minPrice}`);
  }
  if (cfg.maxPrice > 0 && cfg.maxPrice < 500000 && setup.entry > cfg.maxPrice) {
    blockers.push(`price ₹${setup.entry.toFixed(2)} > max ₹${cfg.maxPrice}`);
  }
  blockers.push(...strategyBlockers(setup.primaryStrategyId, cfg, ctx));
  if (ctx.entriesToday >= cfg.maxEntriesPerDay) blockers.push(`daily entry cap ${cfg.maxEntriesPerDay} reached`);

  // Portfolio: several entries from one strategy, or all on one side, are one
  // correlated bet sized as several. Cap the concentration, not just the count.
  if (ctx.open) {
    if (ctx.open.total >= cfg.maxOpenPositions) blockers.push(`${ctx.open.total} positions open (max ${cfg.maxOpenPositions})`);
    const byLead = ctx.open.byStrategy[setup.primaryStrategyId] ?? 0;
    if (byLead >= cfg.maxPerStrategy) blockers.push(`${byLead} open from ${setup.primaryStrategyId} (max ${cfg.maxPerStrategy})`);
    const sameSide = ctx.open.bySide[setup.side] ?? 0;
    if (sameSide >= cfg.maxSameSide) blockers.push(`${sameSide} ${setup.side === 'BUY' ? 'long' : 'short'} positions open (max ${cfg.maxSameSide})`);
  }

  return { route, blockers };
}

// Shared with the dashboard and scanner so every view prices a setup the same way.
export { repriceToMarket } from '@tradeforger/strategy';

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
      const ltp = this.src.ltp(t.instrumentKey);
      // Every setup is priced at the live LTP: swing strategies read yesterday's close.
      const r = analyzeHybrid(
        { instrumentKey: t.instrumentKey, symbol: t.symbol, intraday, daily: this.src.daily(t.instrumentKey), clock: this.clock, ltp },
        {
          params, ...(strategies && strategies.length ? { strategies } : {}),
          canLead: (v) => canLead(v, t, cfg, ctx),
        },
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
          invalidReason: s.invalidReason ?? null,
        };
        const d = decide(base, t, cfg, ctx);
        setups.push({ ...base, route: d.route, blockers: d.blockers, eligible: d.route !== null && d.blockers.length === 0 });
      }
      const a: LiveAnalysis = {
        instrumentKey: t.instrumentKey, symbol: t.symbol, ltp,
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
