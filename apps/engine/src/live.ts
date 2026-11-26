import { z } from 'zod';
import { FixedClock, istDateKey, paiseToRupees, type Candle, type Clock, type EntrySession, type Mode, type Side } from '@tradeforger/core';
import { atr, latest, vwap } from '@tradeforger/indicators';
import {
  analyzeHybrid, completeBars15, dayChangePct, getStrategy, guardSignalStop, marketDirection, trendBias15,
  type HybridSetup, type StrategyVote, type Params, type TrendBias, type OptionWalls,
} from '@tradeforger/strategy';

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
  /** Entries allowed in each entry session (09:30–11:30, 13:30–14:45), inside the daily cap. */
  maxEntriesMorning: z.number().int().min(0).max(50).default(5),
  maxEntriesAfternoon: z.number().int().min(0).max(50).default(3),
  /** Open positions allowed in one NSE industry — several are one correlated bet. */
  maxPerSector: z.number().int().min(1).max(50).default(2),
  /** Minutes before a symbol may be entered again after a position in it closes (one 5-min bar). */
  reentryCooldownMin: z.number().int().min(0).max(120).default(5),
  /**
   * Intraday setups are read off CLOSED 5-minute bars only. With this off they
   * include the still-forming bar, and a signal can appear and vanish within it.
   */
  closedBarEntries: z.boolean().default(true),
  /** Intraday entries only in the direction of the 15-minute trend (VWAP, EMA20/50, ADX). */
  htfBias: z.boolean().default(true),
  /**
   * Strict: VWAP side, EMA20/50 and ADX must all agree. Otherwise (default)
   * price must be on the trade's side of 15-min VWAP and the 15-min trend
   * must not be fully against it — an early trend whose EMAs have not crossed
   * yet still trades.
   */
  htfBiasStrict: z.boolean().default(false),
  /**
   * Exhaustion guard: a trend entry no further than this many ATRs from
   * session VWAP. Beyond it the move has already happened and the entry is
   * the last one in (PFOCUS, 23 Nov: shorted 7.7 ATR under VWAP, stopped
   * out). Counter-trend strategies are exempt — the stretch is their setup.
   * 0 turns it off.
   */
  maxVwapStretchAtr: z.number().min(0).max(20).default(5),
  /**
   * An intraday setup is entered only while fresh: within this many minutes
   * of first signalling. One that waited out a full position cap or the
   * midday block is stale by the time a slot opens, and is skipped for a new
   * signal rather than taken the second the slot frees. 0 turns it off.
   */
  maxSetupAgeMin: z.number().int().min(0).max(120).default(10),
  /**
   * Smallest intraday stop distance, % of entry. Charges and slippage are a
   * near-fixed share of the money traded, so on a tight stop they are a large
   * share of the risk: on two months of 5-minute data (19 NSE stocks) stops
   * under 0.5% lost about 0.3R a trade to costs, and requiring 0.5% halved the
   * loss per trade in both months. 0 turns it off.
   */
  minStopPct: z.number().min(0).max(5).default(0.5),
  /**
   * Move a stop that sits on a stop cluster (previous-day high/low, opening
   * range, equal highs/lows, a round number) just beyond the sweep zone, if
   * that is a small move. Backtested: a small, consistent improvement.
   */
  stopClusterGuard: z.boolean().default(true),
  /**
   * Trend entries only with the market: buy when the NIFTY's 15-min EMAs
   * point up and it trades above today's open, short on the mirror. Better in
   * both months of the two-month backtest. Counter-trend strategies exempt.
   */
  marketFilter: z.boolean().default(true),
  /** Trend entries only in stocks beating the NIFTY today (buys) or lagging it (shorts). */
  relativeStrength: z.boolean().default(true),
  /**
   * Intraday trend targets at this multiple of the risk; 0 keeps each
   * strategy's own. 12 months, 19 NSE stocks, with the daily-range cap below:
   * 3R −0.131R a trade, 2.5R −0.141R, 2R −0.145R — lower targets cut the
   * winners more than they add wins. The cap, not a lower multiple, is what
   * keeps a target realistic for the day.
   */
  targetR: z.number().min(0).max(6).default(3),
  /**
   * Cap intraday targets at this multiple of prior-day 14d Daily ATR from
   * today's open (0 turns off). Prevents demanding +6% from a stock whose daily ATR is 2%.
   */
  maxTargetDailyAtr: z.number().min(0).max(5).default(1.5),
  /**
   * Reject intraday setups whose live LTP has already chased > N ATRs past
   * bar-close signal entry (or > 1.5N ATRs past breakout trigger). 0 = off.
   */
  maxEntryChaseAtr: z.number().min(0).max(5).default(0.5),
  /**
   * Cost-buffered breakeven & staged ATR trail once in profit (+1.2R -> +0.35R,
   * +1.6R -> trail by 1.25 ATR). Off: over 12 months it did worse than the
   * fixed target (−0.150R vs −0.141R a trade), live it ratchets on ticks where
   * the test used closes, and its stop lives only in engine memory — a restart
   * drops it while the exchange stop stays at −1R.
   */
  stagedTrail: z.boolean().default(false),
  /**
   * Reject entries where round-trip costs at the stop exceed this % of 1R risk
   * (e.g. ₹13 cost on ₹43 risk = 30% > 20%). 0 turns off.
   */
  maxCostPctOfRisk: z.number().min(0).max(100).default(20),
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
  /**
   * Intraday exposure ceiling as a multiple of the account's capital: with
   * ₹4,000 and 3×, open MIS positions may total ₹12,000. Risk per trade is
   * still a % of capital at the stop — leverage changes how many shares, never
   * how much a stop-out loses. Delivery is always 1×.
   */
  maxLeverage: z.number().min(1).max(5).default(3),
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
  maxEntriesMorning: 5,
  maxEntriesAfternoon: 3,
  maxPerSector: 2,
  reentryCooldownMin: 5,
  closedBarEntries: true,
  htfBias: true,
  htfBiasStrict: false,
  maxVwapStretchAtr: 5,
  maxSetupAgeMin: 10,
  minStopPct: 0.65,
  stopClusterGuard: true,
  marketFilter: true,
  relativeStrength: true,
  targetR: 3,
  maxTargetDailyAtr: 1.5,
  maxEntryChaseAtr: 0.5,
  stagedTrail: false,
  maxCostPctOfRisk: 20,
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
  maxLeverage: 3,
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
  /** The 15-minute trend an intraday entry must agree with. */
  readonly bias: TrendBias | null;
  /** (price − session VWAP) ÷ 5-min ATR, signed; null when either is unknown. */
  readonly vwapStretchAtr?: number | null;
  /** The NIFTY's direction now; undefined when the analyser has no market data at all. */
  readonly marketSide?: Side | null;
  /** The stock's day change minus the NIFTY's, percentage points. */
  readonly relStrengthPct?: number | null;
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
  /** NSE industry, for the per-sector cap; null when unknown (indices, outside the Nifty 500). */
  readonly sector?: string | null;
}

export interface DecisionContext {
  readonly mode: Mode;
  /** Strategy has a human-APPROVED registry version. */
  readonly approved: (strategyId: string) => boolean;
  readonly entriesToday: number;
  /** The entry session now (null outside both), and the entries already made in each. */
  readonly session?: EntrySession | null;
  readonly entriesBySession?: Readonly<Record<EntrySession, number>>;
  /** Seconds left before this symbol may be re-entered after an exit; 0 when free. */
  readonly reentryWaitSec?: (symbol: string) => number;
  /** What is open right now, for the portfolio limits. */
  readonly open?: {
    readonly total: number;
    readonly byStrategy: Readonly<Record<string, number>>;
    readonly bySide: Readonly<Record<'BUY' | 'SELL', number>>;
    readonly bySector?: Readonly<Record<string, number>>;
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

/** Return instrument keys whose last tick is missing or older than `maxAgeMs`. */
export function staleInstruments(
  keys: Iterable<string>,
  lastTickByKey: ReadonlyMap<string, number>,
  nowMs: number,
  maxAgeMs = 3000,
): string[] {
  const stale: string[] = [];
  for (const k of keys) {
    const last = lastTickByKey.get(k);
    if (last === undefined || nowMs - last >= maxAgeMs) stale.push(k);
  }
  return stale;
}

/** Reject an intraday entry when LTP has already bolted too far past signal close or breakout trigger. */
export function chaseBlocker(
  setup: Pick<LiveSetup, 'style' | 'side' | 'entry' | 'barCloseEntry' | 'signalEntry' | 'atr' | 'primaryStrategyId'>,
  cfg: AutoConfig,
): string | null {
  if (setup.style !== 'INTRADAY' || cfg.maxEntryChaseAtr <= 0 || !setup.atr || !(setup.atr > 0)) return null;
  const long = setup.side === 'BUY';
  const dir = long ? 1 : -1;
  if (setup.barCloseEntry !== undefined) {
    const slipAtr = ((setup.entry - setup.barCloseEntry) * dir) / setup.atr;
    if (slipAtr > cfg.maxEntryChaseAtr) {
      return `entry chased ${slipAtr.toFixed(2)} ATR past bar close (max ${cfg.maxEntryChaseAtr})`;
    }
  }
  if (!getStrategy(setup.primaryStrategyId)?.counterTrend && setup.signalEntry !== undefined) {
    const trigCap = cfg.maxEntryChaseAtr * 1.5;
    const chaseAtr = ((setup.entry - setup.signalEntry) * dir) / setup.atr;
    if (chaseAtr > trigCap) {
      return `entry chased ${chaseAtr.toFixed(2)} ATR past breakout trigger ₹${setup.signalEntry.toFixed(2)} (max ${trigCap.toFixed(2)})`;
    }
  }
  return null;
}
/** Which symbols can be traded on this side? */
export const sideAllowed = (side: Side, tradeSide: AutoConfig['tradeSide']): boolean =>
  tradeSide === 'BOTH' || tradeSide === side;

/** Why this side cannot be entered on this route, or null. */
export function sideBlocker(side: Side, route: Route | null, cfg: AutoConfig): string | null {
  if (!sideAllowed(side, cfg.tradeSide)) return `direction filter is ${cfg.tradeSide === 'BUY' ? 'buy only' : 'short only'}`;
  if (side === 'SELL' && route === 'EQ_SWING') return 'swing SELL would sell delivery holdings — never automated';
  return null;
}

/**
 * Why an intraday entry this way is against the 15-minute trend, or null.
 * A trend strategy needs the trend with it; a counter-trend one (mean
 * reversion, traps, OI walls) fades moves by design, so it is stopped only
 * by a 15-minute trend running against it.
 */
export function biasBlocker(
  style: 'INTRADAY' | 'SWING', side: Side, bias: TrendBias | null, cfg: AutoConfig, strategyId?: string,
): string | null {
  if (!cfg.htfBias || style !== 'INTRADAY') return null;
  if (strategyId && getStrategy(strategyId)?.counterTrend) {
    return bias?.side && bias.side !== side ? `${side} fade against a 15-min trend — ${bias.reason}` : null;
  }
  if (!bias) return '15-min bias unavailable';
  if (cfg.htfBiasStrict) return bias.side === side ? null : `${side} against 15-min bias — ${bias.reason}`;
  if (bias.side && bias.side !== side) return `${side} against a 15-min trend — ${bias.reason}`;
  // An index has no VWAP; its EMAs carry the read alone.
  const read = bias.vwapSide ?? bias.emaSide;
  if (read !== side) {
    return bias.vwapSide ? `${side} with price on the wrong side of 15-min VWAP — ${bias.reason}` : `${side} against 15-min EMAs — ${bias.reason}`;
  }
  return null;
}

/** Why a trend entry this way chases a move already far from VWAP, or null. */
export function stretchBlocker(
  style: 'INTRADAY' | 'SWING', side: Side, stretch: number | null | undefined, cfg: AutoConfig, strategyId?: string,
): string | null {
  if (style !== 'INTRADAY' || !cfg.maxVwapStretchAtr || stretch == null) return null;
  if (strategyId && getStrategy(strategyId)?.counterTrend) return null;
  const along = side === 'BUY' ? stretch : -stretch;
  return along > cfg.maxVwapStretchAtr
    ? `${side} chases a move ${along.toFixed(1)} ATR from VWAP (max ${cfg.maxVwapStretchAtr})`
    : null;
}

/** Why a trend entry is against the market or in a stock the market is beating, or null. */
export function marketBlockers(
  setup: Pick<LiveSetup, 'style' | 'side' | 'primaryStrategyId' | 'marketSide' | 'relStrengthPct'>, target: Target, cfg: AutoConfig,
): string[] {
  if (setup.style !== 'INTRADAY' || getStrategy(setup.primaryStrategyId)?.counterTrend) return [];
  const out: string[] = [];
  if (cfg.marketFilter) {
    if (setup.marketSide === undefined) out.push('NIFTY data unavailable — market direction unknown');
    else if (setup.marketSide !== setup.side) {
      out.push(`NIFTY ${setup.marketSide === null ? 'has no clear direction' : setup.marketSide === 'BUY' ? 'is rising' : 'is falling'} — no ${setup.side === 'BUY' ? 'longs' : 'shorts'}`);
    }
  }
  // An index or future has no "versus the index".
  if (cfg.relativeStrength && target.cashTradeable) {
    const rs = setup.relStrengthPct;
    if (rs == null) out.push('relative strength unknown');
    else if ((setup.side === 'BUY' ? rs : -rs) <= 0) {
      out.push(`${rs >= 0 ? '+' : ''}${rs.toFixed(2)}% vs NIFTY — ${setup.side === 'BUY' ? 'weaker' : 'stronger'} than the market`);
    }
  }
  return out;
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
export function canLead(
  vote: StrategyVote, target: Target, cfg: AutoConfig, ctx: DecisionContext, bias: TrendBias | null = null, stretch: number | null = null,
): boolean {
  if (!vote.side) return false;
  if (sideBlocker(vote.side, routeFor(vote.style, target, cfg).route, cfg)) return false;
  if (biasBlocker(vote.style, vote.side, bias, cfg, vote.strategyId)) return false;
  if (stretchBlocker(vote.style, vote.side, stretch, cfg, vote.strategyId)) return false;
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
  const bias = biasBlocker(setup.style, setup.side, setup.bias, cfg, setup.primaryStrategyId);
  if (bias) blockers.push(bias);
  const stretch = stretchBlocker(setup.style, setup.side, setup.vwapStretchAtr, cfg, setup.primaryStrategyId);
  if (stretch) blockers.push(stretch);
  const chase = chaseBlocker(setup, cfg);
  if (chase) blockers.push(chase);
  blockers.push(...marketBlockers(setup, target, cfg));

  if (setup.invalidReason) blockers.push(setup.invalidReason);
  if (!cfg.enabled) blockers.push('autonomous mode off');
  if (setup.quality < cfg.minQuality) blockers.push(`quality ${setup.quality} < ${cfg.minQuality}`);
  if (setup.rewardRisk < cfg.minRewardRisk) blockers.push(`R:R ${setup.rewardRisk.toFixed(2)} < ${cfg.minRewardRisk}`);
  const stopPct = setup.entry > 0 ? (Math.abs(setup.entry - setup.stopLoss) / setup.entry) * 100 : 0;
  if (setup.style === 'INTRADAY' && cfg.minStopPct > 0 && stopPct < cfg.minStopPct) {
    blockers.push(`stop ${stopPct.toFixed(2)}% from entry — charges eat the edge (min ${cfg.minStopPct}%)`);
  }
  if (setup.stableSeconds < cfg.confirmSeconds) blockers.push(`stable ${setup.stableSeconds}s < ${cfg.confirmSeconds}s`);
  if (setup.style === 'INTRADAY' && cfg.maxSetupAgeMin > 0 && setup.stableSeconds > cfg.maxSetupAgeMin * 60) {
    blockers.push(`stale: signalling for ${Math.floor(setup.stableSeconds / 60)} min (max ${cfg.maxSetupAgeMin}) — waiting for a fresh setup`);
  }
  if (cfg.minPrice > 0 && setup.entry < cfg.minPrice) {
    blockers.push(`price ₹${setup.entry.toFixed(2)} < min ₹${cfg.minPrice}`);
  }
  if (cfg.maxPrice > 0 && cfg.maxPrice < 500000 && setup.entry > cfg.maxPrice) {
    blockers.push(`price ₹${setup.entry.toFixed(2)} > max ₹${cfg.maxPrice}`);
  }
  blockers.push(...strategyBlockers(setup.primaryStrategyId, cfg, ctx));
  if (ctx.entriesToday >= cfg.maxEntriesPerDay) blockers.push(`daily entry cap ${cfg.maxEntriesPerDay} reached`);
  if (ctx.session && ctx.entriesBySession) {
    const cap = ctx.session === 'MORNING' ? cfg.maxEntriesMorning : cfg.maxEntriesAfternoon;
    if (ctx.entriesBySession[ctx.session] >= cap) blockers.push(`${ctx.session.toLowerCase()} entry cap ${cap} reached`);
  }
  const wait = ctx.reentryWaitSec?.(target.symbol) ?? 0;
  if (wait > 0) blockers.push(`re-entry cooldown: ${target.symbol} closed recently, ${wait}s left`);

  // Portfolio: several entries from one strategy, or all on one side, are one
  // correlated bet sized as several. Cap the concentration, not just the count.
  if (ctx.open) {
    if (ctx.open.total >= cfg.maxOpenPositions) blockers.push(`${ctx.open.total} positions open (max ${cfg.maxOpenPositions})`);
    const byLead = ctx.open.byStrategy[setup.primaryStrategyId] ?? 0;
    if (byLead >= cfg.maxPerStrategy) blockers.push(`${byLead} open from ${setup.primaryStrategyId} (max ${cfg.maxPerStrategy})`);
    const sameSide = ctx.open.bySide[setup.side] ?? 0;
    if (sameSide >= cfg.maxSameSide) blockers.push(`${sameSide} ${setup.side === 'BUY' ? 'long' : 'short'} positions open (max ${cfg.maxSameSide})`);
    const inSector = target.sector ? ctx.open.bySector?.[target.sector] ?? 0 : 0;
    if (target.sector && inSector >= cfg.maxPerSector) blockers.push(`${inSector} open in ${target.sector} (max ${cfg.maxPerSector} per sector)`);
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

const BAR_MS = 5 * 60_000;

/** Completed 14-day Daily ATR from prior sessions (excluding today's partial daily bar if present). */
export function priorDailyAtr(daily: readonly Candle[], todayKey: string): number | null {
  if (daily.length === 0) return null;
  const last = daily[daily.length - 1]!;
  const completed = istDateKey(new Date(last.ts)) === todayKey ? daily.slice(0, -1) : daily;
  if (completed.length < 15) return null;
  const a = latest(atr(completed, 14));
  return a !== null && a > 0 ? a : null;
}

export interface TargetRestateOptions {
  readonly dailyAtr?: number | null;
  readonly dayOpen?: number | null;
  readonly maxDailyAtrMultiple?: number;
}

/**
 * The setup with its lead's target restated at `r` times the risk, for a
 * trend strategy, optionally capped at `dayOpen ± maxDailyAtrMultiple × DailyATR`.
 * Counter-trend targets (VWAP, the far OI wall) are levels, not multiples, and
 * stay as the strategy set them.
 */
export function restateTarget(s: HybridSetup, r: number, opts?: TargetRestateOptions): HybridSetup {
  if (getStrategy(s.primaryStrategyId)?.counterTrend) return s;
  const lead = s.votes.find((v) => v.strategyId === s.primaryStrategyId);
  if (!lead?.signal) return s;
  const risk = Math.abs(lead.signal.entry - lead.signal.stopLoss);
  const dir = lead.signal.side === 'BUY' ? 1 : -1;
  let target = r > 0 ? Math.round(lead.signal.entry + dir * risk * r) : lead.signal.target;

  let adrCapped = false;
  let adrExhausted = false;
  if (opts?.maxDailyAtrMultiple && opts.maxDailyAtrMultiple > 0 && opts.dailyAtr && opts.dailyAtr > 0 && opts.dayOpen && opts.dayOpen > 0) {
    const capPaise = Math.round((opts.dayOpen + dir * opts.maxDailyAtrMultiple * opts.dailyAtr) * 100);
    if (dir === 1 ? target > capPaise : target < capPaise) {
      if (dir === 1 ? capPaise <= lead.signal.entry : capPaise >= lead.signal.entry) {
        adrExhausted = true;
      } else {
        target = capPaise;
        adrCapped = true;
      }
    }
  }

  if (adrExhausted) {
    return {
      ...s,
      rewardRisk: 0,
      invalidReason: `daily ADR target cap (${opts!.maxDailyAtrMultiple}× ATR) already passed before entry`,
    };
  }

  if (target <= 0) return s;
  const signedDist = (target - lead.signal.entry) * dir;
  const actualRR = risk > 0 && signedDist > 0 ? Math.round((signedDist / risk) * 100) / 100 : 0;
  if (target === lead.signal.target && !adrCapped) return s;
  const signal = { ...lead.signal, target: target as typeof lead.signal.target };
  return {
    ...s,
    target: paiseToRupees(signal.target),
    rewardRisk: actualRR,
    votes: s.votes.map((v) => (v === lead ? { ...v, signal } : v)),
    ...(adrCapped ? { reasons: [...s.reasons, `target capped within ${opts!.maxDailyAtrMultiple}× Daily ATR`] } : {}),
  };
}

/**
 * The setup with its lead's stop moved out of any stop cluster, and its
 * reward:risk restated for the new stop. The lead vote's signal carries the
 * same stop, since that is what the entry is placed from.
 */
export function guardSetupStop(s: HybridSetup, closed: readonly Candle[]): HybridSetup {
  const lead = s.votes.find((v) => v.strategyId === s.primaryStrategyId);
  if (!lead?.signal) return s;
  const signal = guardSignalStop(lead.signal, closed);
  if (signal === lead.signal) return s;
  const [entry, stop, target] = [signal.entry, signal.stopLoss, signal.target].map(paiseToRupees) as [number, number, number];
  return {
    ...s,
    stopLoss: stop,
    rewardRisk: Math.round((Math.abs(target - entry) / Math.abs(entry - stop)) * 100) / 100,
    votes: s.votes.map((v) => (v === lead ? { ...v, signal } : v)),
    reasons: [...s.reasons, signal.reasons[signal.reasons.length - 1]!],
  };
}

/**
 * How long `strategyId` has already been signalling `side`, from the closed
 * bars before the last: walk back one bar at a time while it still fires the
 * same way, up to `maxBars`. Run when a setup is first seen — after a restart
 * or on a newly picked stock — so a signal that has stood all morning is not
 * taken for a new one.
 */
export function signalAgeMs(
  strategyId: string, side: Side, closed: readonly Candle[], daily: readonly Candle[],
  params: Params | undefined, maxBars: number, ctx: { instrumentKey: string; symbol: string }, now?: number,
): number {
  const def = getStrategy(strategyId);
  if (!def || def.timeframe === '1d') return 0;
  const is15m = def.timeframe === '15m';
  const series = is15m ? completeBars15(closed) : closed;
  const stepMs = is15m ? 3 * BAR_MS : BAR_MS;
  const profile = def.create(params);
  let bars = 0;
  while (bars < maxBars) {
    const past = series.slice(0, series.length - 1 - bars);
    const last = past[past.length - 1];
    if (!last) break;
    const s = profile.evaluate({ ...ctx, candles: past, higherTf: daily, clock: new FixedClock(new Date(last.ts + stepMs)) });
    if (!s || s.side !== side) break;
    bars++;
  }
  // The signal has stood since the bar it came from closed, not since it was
  // first seen: on a 15-min bar that is up to 15 minutes the earlier bars miss.
  const latestBar = series[series.length - 1];
  const sinceClose = now !== undefined && latestBar ? Math.max(0, now - (latestBar.ts + stepMs)) : 0;
  return bars * stepMs + sinceClose;
}

/** How far the price sits from today's VWAP in 5-min ATRs, signed, from closed bars. */
export function vwapStretchAtr(closed: readonly Candle[], ltp: number | null): number | null {
  const a = latest(atr(closed, 14));
  const vw = latest(vwap(closed));
  const price = ltp ?? closed[closed.length - 1]?.close ?? null;
  if (a === null || a <= 0 || vw === null || price === null) return null;
  return (price - vw) / a;
}

export interface CandleSource {
  /** Prior sessions + today's closed 5-min bars, oldest first. */
  intraday(key: string): readonly Candle[];
  /** The still-forming 5-min bar, if any. */
  partial(key: string): Candle | null;
  daily(key: string): readonly Candle[];
  ltp(key: string): number | null;
  /** Option-chain walls for an F&O underlying whose chain is loaded. */
  options?(key: string): OptionWalls | null;
  /** The NIFTY 50's 5-min bars (prior sessions + today), for market direction and relative strength. */
  market?(): readonly Candle[];
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
    const market = this.src.market ? this.src.market().filter((c) => c.ts + BAR_MS <= now) : null;
    const marketSide = market && market.length > 0 ? marketDirection(market) : undefined;
    const marketChange = market && market.length > 0 ? dayChangePct(market) : null;

    for (const t of targets) {
      // A REST fetch can hand back the bar still forming; only bars whose five
      // minutes are over count as closed.
      const closed = this.src.intraday(t.instrumentKey).filter((c) => c.ts + BAR_MS <= now);
      const partial = cfg.closedBarEntries ? null : this.src.partial(t.instrumentKey);
      const intraday = partial ? mergeCandles(closed, [partial]) : closed;
      const bias = closed.length > 0 ? trendBias15(closed) : null;
      const ltp = this.src.ltp(t.instrumentKey);
      const stretch = vwapStretchAtr(closed, ltp);
      // Every setup is priced at the live LTP: swing strategies read yesterday's close.
      const r = analyzeHybrid(
        {
          instrumentKey: t.instrumentKey, symbol: t.symbol, intraday, daily: this.src.daily(t.instrumentKey), clock: this.clock, ltp,
          options: this.src.options?.(t.instrumentKey) ?? null,
        },
        {
          params, ...(strategies && strategies.length ? { strategies } : {}),
          canLead: (v) => canLead(v, t, cfg, ctx, bias, stretch),
        },
      );

      const setups: LiveSetup[] = [];
      const daily = this.src.daily(t.instrumentKey);
      const todayKey = istDateKey(this.clock.now());
      const todayOpen = closed.find((c) => istDateKey(new Date(c.ts)) === todayKey)?.open ?? null;
      const dAtr = priorDailyAtr(daily, todayKey);
      for (const found of [r.best.INTRADAY, r.best.SWING]) {
        if (!found) continue;
        // Guard stop cluster FIRST, then compute targetR & ADR cap from final stop distance.
        const guarded = cfg.stopClusterGuard && found.style === 'INTRADAY' ? guardSetupStop(found, closed) : found;
        const s = guarded.style === 'INTRADAY'
          ? restateTarget(guarded, cfg.targetR, { dailyAtr: dAtr, dayOpen: todayOpen, maxDailyAtrMultiple: cfg.maxTargetDailyAtr })
          : guarded;
        const def = getStrategy(s.primaryStrategyId);
        const tfStep = def?.timeframe === '15m' ? 3 : 1;
        const key = `${t.instrumentKey}|${s.style}`;
        seen.add(key);
        const sig = `${s.side}|${s.primaryStrategyId}`;
        const prev = this.stability.get(key);
        let since = prev && prev.sig === sig ? prev.since : now;
        // First sight, or a new lead/side: measure how long it has really been
        // signalling, so neither a restart nor a change of lead makes it new.
        if (since === now && s.style === 'INTRADAY' && cfg.closedBarEntries && cfg.maxSetupAgeMin > 0) {
          since -= signalAgeMs(
            s.primaryStrategyId, s.side, closed, daily, params[s.primaryStrategyId],
            Math.ceil(cfg.maxSetupAgeMin / (5 * tfStep)) + 1, t, now,
          );
        }
        this.stability.set(key, { sig, since });
        const base = {
          ...s,
          stableSince: since,
          stableSeconds: Math.floor((now - since) / 1000),
          partialBar: partial !== null && s.style === 'INTRADAY',
          bias: s.style === 'INTRADAY' ? bias : null,
          vwapStretchAtr: s.style === 'INTRADAY' ? stretch : null,
          ...(marketSide !== undefined ? { marketSide } : {}),
          relStrengthPct: (() => {
            const own = dayChangePct(closed);
            return own !== null && marketChange !== null ? Math.round((own - marketChange) * 100) / 100 : null;
          })(),
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
