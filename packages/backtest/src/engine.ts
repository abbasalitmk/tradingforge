import {
  type Candle, type Signal, FixedClock, SESSION, paiseToRupees, istDateKey, istMinutes, entrySession,
} from '@tradeforger/core';
import {
  type Params, type StrategyDefinition, type StrategyProfile,
  completeBars15, trendBias15, marketDirection, dayChangePct, guardSignalStop,
} from '@tradeforger/strategy';
import { atr, vwap } from '@tradeforger/indicators';
import {
  type CostModel, EQUITY_INTRADAY, EQUITY_DELIVERY, roundTripCost,
} from './costs.ts';

/** One instrument's history. Candles must be oldest first with strictly increasing ts. */
export interface Dataset {
  symbol: string;
  instrumentKey: string;
  candles: readonly Candle[];
}

export interface BacktestConfig {
  /** Notional account size in rupees. Sizing is fixed-fractional on THIS
   *  figure (no compounding), so early and late trades are comparable. */
  capital: number;
  /** Rupee risk per trade as % of capital (distance to stop x qty). */
  riskPct: number;
  /** Cap on position value as % of capital. 100 = no leverage. */
  maxPositionPct: number;
  costs: CostModel;
  /** Applied against the trader on every market-type fill (entry, stop, EOD,
   *  TIME, END_OF_DATA). Target fills are limit orders and get no slippage. */
  slippageBps: number;
  /** Swing only: exit 'TIME' at the close of the Nth bar held. Default 20. */
  maxHoldBars?: number;
  /** Bars handed to the strategy per evaluation. Default 300 (5m) / 200 (15m) / 260 (1d),
   *  never fewer than the profile's warmupBars. */
  lookbackBars?: number;
  /** Move the stop as the trade works. Off when absent. */
  trail?: TrailConfig;
  /** Override raw strategy target on trend strategies (`targetR * risk`). */
  targetR?: number;
  /** Cap intraday target at `dayOpen ± maxTargetDailyAtr * DailyATR(14)` using completed prior sessions. */
  maxTargetDailyAtr?: number;
  /** Reject capped/re-stated setups whose final R:R drops below this (default 1.5 when ADR-capped). */
  minRewardRisk?: number;
  /** Minimum stop distance as % of entry (intraday live-parity rule). */
  minStopPct?: number;
  /** Reject trend signals stretched further than this many ATRs from session VWAP. */
  maxVwapStretchAtr?: number;
  /** Require intraday trend signals to align with 15-min bias (`trendBias15`). */
  htfBias?: boolean;
  /** Move stop out of local liquidity cluster before restating target. */
  stopClusterGuard?: boolean;
  /** Skip entries whose round-trip costs at stop exceed this % of 1R risk. */
  maxChargePctOfRisk?: number;
  /** Restrict intraday entries to live ENTRY_SESSIONS (09:30–11:30 & 13:30–14:45 IST). */
  entrySessionsOnly?: boolean;
  /** Optional index 5m series for NIFTY direction + relative-strength live parity. */
  marketSeries?: readonly Candle[];
}

/**
 * Staged stop management, on CLOSING prices so a bar's own wick never moves
 * the stop it is then tested against: once the best close since entry is
 * `breakevenR` in profit the stop goes to `entry + breakevenLockR * risk`
 * (covering round-trip costs when > 0); from `trailFromR` it trails
 * that best close by `trailAtr` × ATR(14). The stop only ever tightens.
 */
export interface TrailConfig {
  readonly breakevenR: number;
  /** Multiple of initial R locked when breakeven triggers (default 0 = entry price). */
  readonly breakevenLockR?: number;
  readonly trailFromR: number;
  readonly trailAtr: number;
}

export const DEFAULT_BACKTEST: BacktestConfig = {
  capital: 100_000,
  riskPct: 1,
  maxPositionPct: 100,
  costs: EQUITY_INTRADAY,
  slippageBps: 5,
  maxHoldBars: 20,
};

/** DEFAULT_BACKTEST with the cost model matching the strategy's product:
 *  intraday → MIS charges, swing → delivery charges. */
export function defaultBacktestFor(def: Pick<StrategyDefinition, 'style'>): BacktestConfig {
  return def.style === 'SWING'
    ? { ...DEFAULT_BACKTEST, costs: EQUITY_DELIVERY }
    : { ...DEFAULT_BACKTEST };
}

export type ExitReason = 'TARGET' | 'STOPLOSS' | 'EOD' | 'TIME' | 'END_OF_DATA';

export interface TradeRecord {
  strategyId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  /** Open time of the entry bar (the fill happens at its open). */
  entryTs: number;
  entryPrice: number;
  /** Bar open time for intrabar/open exits; bar close time for close exits. */
  exitTs: number;
  exitPrice: number;
  qty: number;
  grossPnl: number;
  costs: number;
  netPnl: number;
  /** netPnl / (initial risk per share x qty). */
  rMultiple: number;
  /** Maximum adverse excursion in R, ≤ 0 (−1 means price touched the stop). */
  maeR: number;
  /** Maximum favourable excursion in R, ≥ 0. */
  mfeR: number;
  exitReason: ExitReason;
  /** Bars the position was exposed to, entry bar included. */
  barsHeld: number;
}

// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const FIVE_MIN_MS = 300_000;
const FIFTEEN_MIN_MS = 900_000;
const DAILY_CLOSE_MS = SESSION.CLOSE * 60_000; // 15:30 IST after IST midnight

export const DEFAULT_LOOKBACK: Readonly<Record<StrategyDefinition['timeframe'], number>> = {
  '5m': 300,
  '15m': 200,
  '1d': 260,
};

/** Resample 5m bars to complete 15m bars when running a `'15m'` strategy (no-op if already 15m+). */
export function candlesForTimeframe(candles: readonly Candle[], timeframe: StrategyDefinition['timeframe']): readonly Candle[] {
  return timeframe === '15m' ? completeBars15(candles) : candles;
}

/** Per-bar calendar facts, computed once per candle array. */
interface BarMeta {
  /** IST day number (days since epoch in IST). */
  readonly day: Int32Array;
  /** Minutes since IST midnight of the bar's open. */
  readonly mins: Int16Array;
  /** When the bar is complete — the moment the strategy may look at it. */
  readonly closeTs: Float64Array;
}

const metaCache = new WeakMap<readonly Candle[], Map<string, BarMeta>>();

/** IST midnight (epoch ms) of the day containing ts. */
export function istMidnight(ts: number): number {
  return Math.floor((ts + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/**
 * When a bar's data is final.
 * - 5m: open + 5 minutes.
 * - 15m: open + 15 minutes.
 * - 1d: 15:30 IST on the bar's IST date. Upstox stamps daily candles at IST
 *   midnight; using the calendar close rather than `ts + 6h15m` is correct for
 *   both midnight-stamped and 09:15-stamped daily bars.
 */
export function barCloseTs(ts: number, timeframe: StrategyDefinition['timeframe']): number {
  if (timeframe === '5m') return ts + FIVE_MIN_MS;
  if (timeframe === '15m') return ts + FIFTEEN_MIN_MS;
  return istMidnight(ts) + DAILY_CLOSE_MS;
}

function barMeta(candles: readonly Candle[], timeframe: StrategyDefinition['timeframe']): BarMeta {
  let byTf = metaCache.get(candles);
  const hit = byTf?.get(timeframe);
  if (hit) return hit;

  const n = candles.length;
  const day = new Int32Array(n);
  const mins = new Int16Array(n);
  const closeTs = new Float64Array(n);
  let prevTs = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    if (!(c.ts > prevTs)) {
      throw new Error(`candles must be oldest-first with strictly increasing ts (index ${i})`);
    }
    prevTs = c.ts;
    const shifted = c.ts + IST_OFFSET_MS;
    day[i] = Math.floor(shifted / DAY_MS);
    mins[i] = Math.floor((shifted - day[i]! * DAY_MS) / 60_000);
    closeTs[i] = barCloseTs(c.ts, timeframe);
  }
  const meta: BarMeta = { day, mins, closeTs };
  if (!byTf) {
    byTf = new Map();
    metaCache.set(candles, byTf);
  }
  byTf.set(timeframe, meta);
  return meta;
}

interface OpenPosition {
  readonly side: 'BUY' | 'SELL';
  readonly entryIdx: number;
  readonly entryPrice: number;
  stop: number;
  readonly target: number;
  /** Best close since entry — the trail's anchor. */
  best: number;
  /** Initial risk per share: |fill − stop|. */
  readonly risk: number;
  readonly qty: number;
  mae: number;
  mfe: number;
}

/** Inclusive-exclusive window in TIME. Entries are counted only when the
 *  fill bar's ts is inside it; bars before `fromTs` are still used as warmup;
 *  bars at/after `toTs` do not exist as far as the simulation is concerned. */
export interface BacktestWindow {
  fromTs?: number;
  toTs?: number;
}

/**
 * A strategy bound to one dataset, with its signals memoised by bar.
 *
 * Evaluation at bar i depends only on candles[i+1-lookback .. i] and the bar's
 * close time, so a signal is the same whichever window or cost assumption it
 * is replayed under. Validation re-runs the same params over in-sample,
 * out-of-sample, every fold and the cost-stress scenario; memoising turns
 * those ~8 replays into one strategy evaluation pass.
 */
export interface PreparedBacktest {
  readonly def: StrategyDefinition;
  readonly data: Dataset;
  run(window?: BacktestWindow, cfg?: BacktestConfig): TradeRecord[];
}

export function prepareBacktest(
  def: StrategyDefinition,
  params: Params | undefined,
  data: Dataset,
  baseCfg: BacktestConfig = defaultBacktestFor(def),
): PreparedBacktest {
  const simCandles = candlesForTimeframe(data.candles, def.timeframe);
  const simData: Dataset = simCandles === data.candles ? data : { ...data, candles: simCandles };
  const candles = simData.candles;
  const meta = barMeta(candles, def.timeframe);
  const profile: StrategyProfile = def.create(params);
  const lookback = Math.max(
    1,
    baseCfg.lookbackBars ?? DEFAULT_LOOKBACK[def.timeframe],
    profile.warmupBars,
  );
  const cache: Array<Signal | null | undefined> = new Array(candles.length);
  const clock = new FixedClock(new Date(0));

  const signalAt = (i: number): Signal | null => {
    const cached = cache[i];
    if (cached !== undefined) return cached;
    let s: Signal | null = null;
    // Cheap pre-check the profile would do anyway, saving the slice.
    if (i + 1 >= profile.warmupBars) {
      clock.set(new Date(meta.closeTs[i]!));
      s = profile.evaluate({
        instrumentKey: simData.instrumentKey,
        symbol: simData.symbol,
        candles: candles.slice(Math.max(0, i + 1 - lookback), i + 1),
        higherTf: [],
        clock,
      });
    }
    cache[i] = s;
    return s;
  };

  return {
    def,
    data: simData,
    run(window: BacktestWindow = {}, cfg: BacktestConfig = baseCfg): TradeRecord[] {
      const from = window.fromTs === undefined ? 0 : lowerBound(candles, window.fromTs);
      const to = window.toTs === undefined ? candles.length : lowerBound(candles, window.toTs);
      if (to - from < 1) return [];
      return simulate(def, simData, data.candles, meta, signalAt, cfg, from, to);
    },
  };
}

/**
 * Bar-by-bar simulation of one strategy on one instrument.
 *
 * Honesty rules (each has a test):
 * - The strategy sees only completed bars, with the clock at the bar's close.
 * - Signals fill at the NEXT bar's open, with slippage against the trader.
 * - If that open has already gapped through the stop (or past the target),
 *   the trade is skipped: the order would have been for a trade that no
 *   longer exists.
 * - Exits are checked on every bar from the fill bar onward (the fill is at
 *   the open, so that whole bar happens after entry). If one bar touches both
 *   stop and target, the STOP is assumed to have come first.
 * - Stops fill at the stop or at a worse gap-open, plus slippage; targets
 *   fill at the target, never better.
 * - Intraday positions are flattened at the first bar at/after 15:05 IST (at
 *   its open), or at the close of the session's last bar if earlier.
 * - One position per instrument at a time.
 */
export function runBacktest(
  def: StrategyDefinition,
  params: Params | undefined,
  data: Dataset,
  cfg?: BacktestConfig,
): TradeRecord[] {
  const c = cfg ?? defaultBacktestFor(def);
  return prepareBacktest(def, params, data, c).run({}, c);
}

/** First index whose ts ≥ t. */
function lowerBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid]!.ts < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Precompute prior completed daily ATR(14) and each session's day open, mapped by bar index (no lookahead, O(N)). */
function intradaySessionStats(candles: readonly Candle[]): { dayOpen: Float64Array; priorAtr14: Float64Array } {
  const n = candles.length;
  const dayOpen = new Float64Array(n);
  const priorAtr14 = new Float64Array(n);
  let curDay = '';
  let dOpen = 0, dHigh = -Infinity, dLow = Infinity, dClose = 0;
  let prevDayClose: number | null = null;
  let dayCount = 0;
  let trSum = 0;
  let atr14 = 0;
  let curPriorAtr = 0;

  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    const dk = istDateKey(new Date(c.ts));
    if (dk !== curDay) {
      if (curDay !== '') {
        // Complete the prior day cleanly in O(1) using Wilder RMA over 14 days.
        const tr = prevDayClose === null
          ? dHigh - dLow
          : Math.max(dHigh - dLow, Math.abs(dHigh - prevDayClose), Math.abs(dLow - prevDayClose));
        dayCount++;
        if (dayCount <= 14) {
          trSum += tr;
          if (dayCount === 14) atr14 = trSum / 14;
        } else {
          atr14 = (atr14 * 13 + tr) / 14;
        }
        prevDayClose = dClose;
        curPriorAtr = atr14;
      }
      curDay = dk;
      dOpen = c.open;
      dHigh = c.high;
      dLow = c.low;
      dClose = c.close;
    } else {
      if (c.high > dHigh) dHigh = c.high;
      if (c.low < dLow) dLow = c.low;
      dClose = c.close;
    }
    dayOpen[i] = dOpen;
    priorAtr14[i] = curPriorAtr;
  }
  return { dayOpen, priorAtr14 };
}

function simulate(
  def: StrategyDefinition,
  data: Dataset,
  raw5mCandles: readonly Candle[],
  meta: BarMeta,
  signalAt: (i: number) => Signal | null,
  cfg: BacktestConfig,
  entryFrom: number,
  to: number,
): TradeRecord[] {
  const candles = data.candles;
  const intraday = def.timeframe !== '1d';
  const slip = cfg.slippageBps / 10_000;
  const maxHold = Math.max(1, cfg.maxHoldBars ?? 20);
  const trades: TradeRecord[] = [];
  const atrSeries = (cfg.trail || (intraday && (cfg.maxVwapStretchAtr ?? 0) > 0)) ? atr(candles, 14) : null;
  const vwSeries = intraday && (cfg.maxVwapStretchAtr ?? 0) > 0 ? vwap(candles) : null;
  const dailyStats = intraday && (cfg.maxTargetDailyAtr ?? 0) > 0 ? intradaySessionStats(candles) : null;
  const need5mContext = intraday && (cfg.htfBias || cfg.marketSeries);
  const fiveMinByClose = need5mContext
    ? new Map(raw5mCandles.map((c, idx) => [c.ts + FIVE_MIN_MS, idx]))
    : null;
  const mktByClose = cfg.marketSeries
    ? new Map(cfg.marketSeries.map((c, idx) => [c.ts + FIVE_MIN_MS, idx]))
    : null;

  /** Market-type fill: always worse for the trader. */
  const against = (price: number, action: 'BUY' | 'SELL'): number =>
    action === 'BUY' ? price * (1 + slip) : price * (1 - slip);

  const close = (
    p: OpenPosition, rawExit: number, reason: ExitReason, exitTs: number, barsHeld: number,
  ): TradeRecord => {
    const long = p.side === 'BUY';
    const exitPrice = reason === 'TARGET' ? rawExit : against(rawExit, long ? 'SELL' : 'BUY');
    const grossPnl = (long ? exitPrice - p.entryPrice : p.entryPrice - exitPrice) * p.qty;
    const costs = roundTripCost(cfg.costs, p.side, p.qty, p.entryPrice, exitPrice);
    const netPnl = grossPnl - costs;
    return {
      strategyId: def.id,
      symbol: data.symbol,
      side: p.side,
      entryTs: candles[p.entryIdx]!.ts,
      entryPrice: p.entryPrice,
      exitTs,
      exitPrice,
      qty: p.qty,
      grossPnl,
      costs,
      netPnl,
      rMultiple: netPnl / (p.risk * p.qty),
      maeR: p.mae,
      mfeR: p.mfe,
      exitReason: reason,
      barsHeld,
    };
  };

  const isLastBarOfSession = (j: number): boolean =>
    j + 1 < candles.length && meta.day[j + 1] !== meta.day[j];

  const tryEnter = (rawSig: Signal, e: number): OpenPosition | null => {
    const bar = candles[e]!;
    if (intraday) {
      // Never carry an intraday signal into the next session, and never open
      // a position the square-off would close on the same bar.
      if (meta.day[e] !== meta.day[e - 1]) return null;
      if (meta.mins[e]! >= SESSION.SQUARE_OFF) return null;
    }

    const sigIdx = e - 1;
    if (intraday && cfg.entrySessionsOnly && !entrySession(new Date(meta.closeTs[sigIdx]!))) {
      return null;
    }
    // Live parity rules checked at signal close (bar sigIdx), before next-bar open fill.
    const ctxSlice = intraday && (cfg.stopClusterGuard || cfg.htfBias)
      ? candles.slice(Math.max(0, sigIdx - 299), sigIdx + 1)
      : null;

    if (intraday && cfg.htfBias && !def.counterTrend) {
      const fiveEnd = def.timeframe === '15m' && fiveMinByClose ? fiveMinByClose.get(meta.closeTs[sigIdx]!) : undefined;
      const fiveSlice = fiveEnd !== undefined ? raw5mCandles.slice(Math.max(0, fiveEnd - 299), fiveEnd + 1) : ctxSlice!;
      const bias = trendBias15(fiveSlice);
      if (bias.side && bias.side !== rawSig.side) return null;
      const read = bias.vwapSide ?? bias.emaSide;
      if (read !== rawSig.side) return null;
    }

    if (intraday && !def.counterTrend && cfg.maxVwapStretchAtr && cfg.maxVwapStretchAtr > 0) {
      const a = atrSeries?.[sigIdx];
      const vw = vwSeries?.[sigIdx];
      if (a && a > 0 && vw != null) {
        const stretch = (candles[sigIdx]!.close - vw) / a;
        const along = rawSig.side === 'BUY' ? stretch : -stretch;
        if (along > cfg.maxVwapStretchAtr) return null;
      }
    }

    if (intraday && !def.counterTrend && cfg.marketSeries && mktByClose) {
      const closeT = meta.closeTs[sigIdx]!;
      const mIdx = mktByClose.get(closeT);
      const fiveEnd = fiveMinByClose?.get(closeT);
      if (mIdx !== undefined && mIdx >= 100) {
        const mSlice = cfg.marketSeries.slice(Math.max(0, mIdx - 299), mIdx + 1);
        const mSide = marketDirection(mSlice);
        if (mSide !== rawSig.side) return null;
        const fiveSlice = fiveEnd !== undefined ? raw5mCandles.slice(Math.max(0, fiveEnd - 150), fiveEnd + 1) : candles.slice(Math.max(0, sigIdx - 150), sigIdx + 1);
        const ownCh = dayChangePct(fiveSlice);
        const mCh = dayChangePct(mSlice);
        if (ownCh !== null && mCh !== null) {
          const rs = ownCh - mCh;
          if ((rawSig.side === 'BUY' ? rs : -rs) <= 0) return null;
        }
      }
    }

    const sig = intraday && cfg.stopClusterGuard && ctxSlice
      ? guardSignalStop(rawSig, ctxSlice)
      : rawSig;

    const long = sig.side === 'BUY';
    const dir = long ? 1 : -1;
    const stop = paiseToRupees(sig.stopLoss);
    let target = paiseToRupees(sig.target);
    if (intraday && !def.counterTrend && cfg.targetR && cfg.targetR > 0) {
      const sigEntryRs = paiseToRupees(sig.entry);
      const sigRisk = Math.abs(sigEntryRs - stop);
      if (sigRisk > 0) target = sigEntryRs + dir * sigRisk * cfg.targetR;
    }

    if (intraday && cfg.maxTargetDailyAtr && cfg.maxTargetDailyAtr > 0 && dailyStats) {
      const dAtr = dailyStats.priorAtr14[sigIdx]!;
      const dOpen = dailyStats.dayOpen[sigIdx]!;
      if (dAtr > 0 && dOpen > 0) {
        const adrCap = dOpen + dir * cfg.maxTargetDailyAtr * dAtr;
        if (long ? target > adrCap : target < adrCap) {
          target = adrCap;
        }
      }
    }

    if (long ? !(stop < target) : !(stop > target)) return null;

    const fill = against(bar.open, sig.side);
    if (long ? bar.open <= stop || fill <= stop : bar.open >= stop || fill >= stop) return null;
    if (long ? fill >= target : fill <= target) return null;

    const risk = Math.abs(fill - stop);
    if (intraday && cfg.minStopPct && cfg.minStopPct > 0 && (risk / fill) * 100 < cfg.minStopPct) return null;

    const finalRR = Math.abs(target - fill) / risk;
    const minRR = cfg.minRewardRisk ?? (cfg.maxTargetDailyAtr ? 1.5 : 0);
    if (minRR > 0 && finalRR < minRR) return null;

    const byRisk = (cfg.capital * cfg.riskPct) / 100 / risk;
    const byValue = (cfg.capital * cfg.maxPositionPct) / 100 / fill;
    const qty = Math.floor(Math.min(byRisk, byValue) + 1e-9);
    if (!(qty >= 1)) return null;

    if (cfg.maxChargePctOfRisk && cfg.maxChargePctOfRisk > 0) {
      const estStopCost = roundTripCost(cfg.costs, sig.side, qty, fill, stop);
      if (estStopCost / (risk * qty) * 100 > cfg.maxChargePctOfRisk) return null;
    }
    return { side: sig.side, entryIdx: e, entryPrice: fill, stop, target, best: fill, risk, qty, mae: 0, mfe: 0 };
  };

  /** Advance an open position through bar j. Returns the trade if it closed. */
  const step = (p: OpenPosition, j: number): TradeRecord | null => {
    const bar = candles[j]!;
    const long = p.side === 'BUY';
    const held = j - p.entryIdx + 1;
    const toR = (price: number): number =>
      (long ? price - p.entryPrice : p.entryPrice - price) / p.risk;

    if (intraday && j > p.entryIdx
      && (meta.mins[j]! >= SESSION.SQUARE_OFF || meta.day[j] !== meta.day[p.entryIdx])) {
      p.mae = Math.min(p.mae, toR(bar.open));
      p.mfe = Math.max(p.mfe, toR(bar.open));
      return close(p, bar.open, 'EOD', bar.ts, held - 1);
    }

    const adverse = long ? bar.low : bar.high;
    const favourable = long ? bar.high : bar.low;
    p.mae = Math.min(p.mae, toR(adverse));

    const gappedThroughStop = long ? bar.open <= p.stop : bar.open >= p.stop;
    const touchedStop = long ? bar.low <= p.stop : bar.high >= p.stop;
    if (gappedThroughStop || touchedStop) {
      // Pessimistic: on the stop bar, no favourable excursion is credited.
      return close(p, gappedThroughStop ? bar.open : p.stop, 'STOPLOSS', bar.ts, held);
    }

    const touchedTarget = long ? bar.high >= p.target : bar.low <= p.target;
    if (touchedTarget) {
      p.mfe = Math.max(p.mfe, toR(p.target));
      return close(p, p.target, 'TARGET', bar.ts, held);
    }
    p.mfe = Math.max(p.mfe, toR(favourable));

    // The bar has closed without an exit: tighten for the bars after it.
    if (cfg.trail) {
      p.best = long ? Math.max(p.best, bar.close) : Math.min(p.best, bar.close);
      const bestR = toR(p.best);
      const tighter = (s: number): void => { if (long ? s > p.stop : s < p.stop) p.stop = s; };
      if (bestR >= cfg.trail.breakevenR) {
        const lock = (cfg.trail.breakevenLockR ?? 0) * p.risk;
        tighter(long ? p.entryPrice + lock : p.entryPrice - lock);
      }
      const a = atrSeries?.[j];
      if (bestR >= cfg.trail.trailFromR && a != null) tighter(long ? p.best - cfg.trail.trailAtr * a : p.best + cfg.trail.trailAtr * a);
    }

    if (intraday) {
      if (isLastBarOfSession(j)) return close(p, bar.close, 'EOD', meta.closeTs[j]!, held);
    } else if (held >= maxHold) {
      return close(p, bar.close, 'TIME', meta.closeTs[j]!, held);
    }
    return null;
  };

  let pos: OpenPosition | null = null;
  for (let i = Math.max(0, entryFrom - 1); i < to; i++) {
    if (pos) {
      const done = step(pos, i);
      if (done) {
        trades.push(done);
        pos = null;
      }
    }
    if (!pos && i + 1 < to && i + 1 >= entryFrom) {
      const sig = signalAt(i);
      if (sig) pos = tryEnter(sig, i + 1);
    }
  }
  if (pos) {
    const last = to - 1;
    const bar = candles[last]!;
    trades.push(close(pos, bar.close, 'END_OF_DATA', meta.closeTs[last]!, last - pos.entryIdx + 1));
  }
  return trades;
}
