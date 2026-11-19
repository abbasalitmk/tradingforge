import {
  type Candle, type Signal, FixedClock, SESSION, paiseToRupees,
} from '@tradeforger/core';
import type { Params, StrategyDefinition, StrategyProfile } from '@tradeforger/strategy';
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
  /** Bars handed to the strategy per evaluation. Default 300 (5m) / 260 (1d),
   *  never fewer than the profile's warmupBars. */
  lookbackBars?: number;
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
const DAILY_CLOSE_MS = SESSION.CLOSE * 60_000; // 15:30 IST after IST midnight

export const DEFAULT_LOOKBACK: Readonly<Record<StrategyDefinition['timeframe'], number>> = {
  '5m': 300,
  '1d': 260,
};

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
 * - 1d: 15:30 IST on the bar's IST date. Upstox stamps daily candles at IST
 *   midnight; using the calendar close rather than `ts + 6h15m` is correct for
 *   both midnight-stamped and 09:15-stamped daily bars.
 */
export function barCloseTs(ts: number, timeframe: StrategyDefinition['timeframe']): number {
  return timeframe === '5m' ? ts + FIVE_MIN_MS : istMidnight(ts) + DAILY_CLOSE_MS;
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
  readonly stop: number;
  readonly target: number;
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
  const candles = data.candles;
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
        instrumentKey: data.instrumentKey,
        symbol: data.symbol,
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
    data,
    run(window: BacktestWindow = {}, cfg: BacktestConfig = baseCfg): TradeRecord[] {
      const from = window.fromTs === undefined ? 0 : lowerBound(candles, window.fromTs);
      const to = window.toTs === undefined ? candles.length : lowerBound(candles, window.toTs);
      if (to - from < 1) return [];
      return simulate(def, data, meta, signalAt, cfg, from, to);
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
 * - Intraday positions are flattened at the first bar at/after 15:10 IST (at
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

function simulate(
  def: StrategyDefinition,
  data: Dataset,
  meta: BarMeta,
  signalAt: (i: number) => Signal | null,
  cfg: BacktestConfig,
  entryFrom: number,
  to: number,
): TradeRecord[] {
  const candles = data.candles;
  const intraday = def.timeframe === '5m';
  const slip = cfg.slippageBps / 10_000;
  const maxHold = Math.max(1, cfg.maxHoldBars ?? 20);
  const trades: TradeRecord[] = [];

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

  const tryEnter = (sig: Signal, e: number): OpenPosition | null => {
    const bar = candles[e]!;
    if (intraday) {
      // Never carry an intraday signal into the next session, and never open
      // a position the square-off would close on the same bar.
      if (meta.day[e] !== meta.day[e - 1]) return null;
      if (meta.mins[e]! >= SESSION.SQUARE_OFF) return null;
    }
    const long = sig.side === 'BUY';
    const stop = paiseToRupees(sig.stopLoss);
    const target = paiseToRupees(sig.target);
    if (long ? !(stop < target) : !(stop > target)) return null;

    const fill = against(bar.open, sig.side);
    if (long ? bar.open <= stop || fill <= stop : bar.open >= stop || fill >= stop) return null;
    if (long ? fill >= target : fill <= target) return null;

    const risk = Math.abs(fill - stop);
    const byRisk = (cfg.capital * cfg.riskPct) / 100 / risk;
    const byValue = (cfg.capital * cfg.maxPositionPct) / 100 / fill;
    const qty = Math.floor(Math.min(byRisk, byValue) + 1e-9);
    if (!(qty >= 1)) return null;
    return { side: sig.side, entryIdx: e, entryPrice: fill, stop, target, risk, qty, mae: 0, mfe: 0 };
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
