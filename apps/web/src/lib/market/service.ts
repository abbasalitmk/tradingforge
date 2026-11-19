import { type Candle, type Clock, type Signal, istMinutes, istDateKey, SESSION, paiseToRupees } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import {
  StockScanner, DEFAULT_UNIVERSE, STRATEGY_CATALOG, analyzeHybrid, prefilter, screen,
  type ScoredStock, type UniverseItem, type ScanFilters, type QuoteLite, type ScanCandidate, type HybridSetup,
} from '@tradeforger/strategy';
import { closes, latest, ema, rsi, atr, adx, supertrend, relativeVolume } from '@tradeforger/indicators';
import { runBacktest, computeMetrics, defaultBacktestFor } from '@tradeforger/backtest';
import { backfill } from '@tradeforger/data';
import type { AiReviewer } from '@tradeforger/ai';
import { FnoDesk, DEFAULT_OPTION_PLAN } from '@tradeforger/fno';
import { MarketData, MarketError, mergeCandles, pool, type Session } from './data.ts';
import { INDEX_CATEGORIES, loadIndex, type IndexList } from './indices.ts';

export { MarketError, type Session } from './data.ts';

/**
 * Most stocks a scan fetches candles for, and how many at once. Each costs up
 * to three Upstox calls; Upstox allows 500 a minute per account, shared with
 * the engine, so a scan stays well inside that and a repeat scan is mostly
 * served from the 30-minute history/daily cache.
 */
const MAX_CANDIDATES = 40;
const CANDLE_CONCURRENCY = 5;
const DAY = 86_400_000;

export interface MarketDeps {
  readonly client: UpstoxClient;
  readonly clock: Clock;
  readonly ai: AiReviewer;
  readonly fnoSymbols?: readonly string[];
  /** Injected in tests; production downloads the Upstox instrument master. */
  readonly loadMasterRows?: () => Promise<readonly unknown[]>;
  /** Injected in tests; production fetches NSE's constituent files. */
  readonly loadIndex?: (id: string) => Promise<IndexList>;
}

export interface ScanRequest {
  /** An INDEX_CATEGORIES id, or 'ALL' for every NSE EQ-series stock. */
  readonly category: string;
  readonly filters: ScanFilters;
}

/** A setup without the full per-strategy signal objects — what the dashboard renders. */
function slimSetup(s: HybridSetup | null) {
  if (!s) return null;
  return {
    ...s,
    votes: s.votes.map((v) => ({ strategyId: v.strategyId, name: v.name, style: v.style, side: v.side, confidence: v.confidence })),
  };
}

const marketOpenAt = (d: Date): boolean => {
  const dow = new Date(d.getTime() + 330 * 60_000).getUTCDay();
  const m = istMinutes(d);
  return dow !== 0 && dow !== 6 && m >= SESSION.OPEN && m < SESSION.CLOSE;
};

/** Cumulative VWAP over today's bars. */
function sessionVwap(bars: readonly Candle[]): number | null {
  let pv = 0, vol = 0;
  for (const c of bars) {
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}

/**
 * Candle fetches that may fail one by one. Each failure is recorded rather
 * than silently becoming "no bars"; if every fetch failed (typically an
 * Upstox rate limit) the first error is thrown so the caller sees why.
 */
class Fetches {
  readonly failures: MarketError[] = [];

  get<T>(p: Promise<T>, fallback: T, what: string): Promise<T> {
    return p.catch((e: unknown) => {
      this.failures.push(e instanceof MarketError ? e : new MarketError(502, 'upstox_candles', `${what}: ${String(e)}`));
      return fallback;
    });
  }

  throwIfAllFailed(attempted: number): void {
    if (attempted > 0 && this.failures.length >= attempted) throw this.failures[0]!;
  }

  warnings(): string[] {
    return [...new Set(this.failures.map((f) => f.message))];
  }
}

const round = (n: number | null | undefined, d = 2): number | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;

/**
 * Read-only market analysis for the dashboard, independent of the engine.
 *
 * Runs on the analytics token alone, so it works from any IP and can never
 * place an order. Uses the same strategy catalog, ensemble and screener as
 * the engine, so both show the same picture.
 */
export class MarketService {
  readonly data: MarketData;
  private readonly clock: Clock;
  private readonly ai: AiReviewer;
  private readonly scanner = new StockScanner();
  private readonly desk: FnoDesk;
  private readonly fetchIndex: (id: string) => Promise<IndexList>;

  constructor(deps: MarketDeps) {
    this.clock = deps.clock;
    this.ai = deps.ai;
    this.data = new MarketData(deps.client, deps.clock, deps.loadMasterRows);
    this.fetchIndex = deps.loadIndex ?? ((id) => loadIndex(id));
    // Options only: futures planning needs a live feed and margin, which needs the static IP.
    this.desk = new FnoDesk({
      client: deps.client,
      clock: deps.clock,
      ltpOf: () => null,
      settings: {
        symbols: deps.fnoSymbols ?? ['NIFTY', 'BANKNIFTY'],
        instrument: 'OPTIONS',
        minDte: 1,
        refreshMs: 60_000,
        plan: DEFAULT_OPTION_PLAN,
      },
    });
  }

  private get cache() {
    return this.data.cache;
  }

  // ─────────────────────────────── catalogue ───────────────────────────────

  /** Scan categories and the strategy catalog, for the dashboard's pickers. */
  catalog() {
    return {
      categories: [
        ...INDEX_CATEGORIES.map(({ id, name, group }) => ({ id, name, group })),
        { id: 'ALL', name: 'All NSE stocks', group: 'Broad' as const },
      ],
      strategies: STRATEGY_CATALOG.map(({ id, name, style, timeframe, description }) => ({ id, name, style, timeframe, description })),
    };
  }

  /** Symbol and name search over every NSE EQ-series stock. */
  async search(query: string, limit = 12) {
    const q = query.trim().toUpperCase();
    if (!q) return { results: [] };
    const { equities } = await this.data.master();
    const rank = (symbol: string, name: string): number =>
      symbol === q ? 0 : symbol.startsWith(q) ? 1 : symbol.includes(q) ? 2 : name.toUpperCase().includes(q) ? 3 : -1;
    const results = equities
      .map((e) => ({ e, r: rank(e.symbol, e.name) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.e.symbol.length - b.e.symbol.length || a.e.symbol.localeCompare(b.e.symbol))
      .slice(0, limit)
      .map(({ e }) => ({ symbol: e.symbol, name: e.name, instrumentKey: e.instrumentKey }));
    return { results };
  }

  // ─────────────────────────────── equities ───────────────────────────────

  async overview() {
    const keys = DEFAULT_UNIVERSE.map((u) => u.instrumentKey);
    const [quotes, bars] = await Promise.all([this.data.quotes(keys), this.rankingBarsFor(keys)]);
    const candleMap = new Map([...bars].map(([k, b]) => [k, b.candles]));
    const rankedStocks = this.scanner.rankUniverse(DEFAULT_UNIVERSE, candleMap);

    const watchlist = DEFAULT_UNIVERSE.map((u) => {
      const q = quotes.get(u.instrumentKey);
      const ltp = q?.last_price ?? 0;
      const change = q?.net_change ?? 0;
      const prevClose = ltp - change;
      return {
        ...u,
        ltp,
        changePct: prevClose > 0 ? (change / prevClose) * 100 : 0,
        open: q?.ohlc?.open ?? 0,
        high: q?.ohlc?.high ?? 0,
        low: q?.ohlc?.low ?? 0,
        close: prevClose > 0 ? prevClose : 0,
        volume: q?.volume ?? 0,
        lastUpdated: this.clock.ms(),
        bars: bars.get(u.instrumentKey)?.candles.length ?? 0,
      };
    });

    return {
      source: 'vercel' as const,
      asOf: this.clock.ms(),
      session: sessionOf(bars.values()),
      watchlist,
      rankedStocks,
      topStock: rankedStocks[0] ?? null,
    };
  }

  /** Same steps as the engine's /scanner/analyze, with the style chosen by the caller. */
  async analyzeStock(symbol: string, style: 'INTRADAY' | 'SWING') {
    const sym = symbol.toUpperCase();
    const item = DEFAULT_UNIVERSE.find((u) => u.symbol === sym) ?? (await this.data.master()).bySymbol.get(sym);
    if (!item) throw new MarketError(404, 'not_in_universe', `${symbol} is not an NSE stock`);
    const { stock, session } = await this.score(item);
    const signal = this.scanner.toSignal(stock, style);
    const consensus = await this.ai.review(signal);
    return { stock, tradeSetup: stock.tradeSetup, signal, consensus, votes: consensus.votes, session };
  }

  /**
   * Two-stage scan of a category: quotes for the whole list, the coarse
   * filters, then candles for the shortlist through every selected strategy.
   * The same prefilter and screener as the engine's full-market scan.
   */
  async scan(req: ScanRequest) {
    const started = this.clock.ms();
    const f = req.filters;
    const limit = Math.min(50, Math.max(1, Math.round(f.limit ?? 25)));

    let universe: Array<{ instrumentKey: string; symbol: string; name: string; industry?: string }>;
    let categoryName: string;
    let listSource: string;
    if (req.category === 'ALL') {
      universe = [...(await this.data.master()).equities];
      categoryName = 'All NSE stocks';
      listSource = 'Upstox instrument master';
    } else {
      if (!INDEX_CATEGORIES.some((c) => c.id === req.category)) {
        throw new MarketError(404, 'unknown_category', `unknown category ${req.category}`);
      }
      const idx = await this.cache.get(`index:${req.category}`, 12 * 3_600_000, () => this.fetchIndex(req.category));
      universe = [...idx.constituents];
      categoryName = idx.category.name;
      listSource = idx.source;
    }
    const industry = new Map(universe.map((u) => [u.instrumentKey, u.industry ?? null]));

    const quotes = await this.data.quotes(universe.map((u) => u.instrumentKey));
    const lite: QuoteLite[] = universe.flatMap((u) => {
      const q = quotes.get(u.instrumentKey);
      if (!q || !(q.last_price > 0)) return [];
      return [{
        instrumentKey: u.instrumentKey, symbol: u.symbol, name: u.name, ltp: q.last_price,
        open: q.ohlc?.open ?? q.last_price, high: q.ohlc?.high ?? q.last_price, low: q.ohlc?.low ?? q.last_price,
        // The quote's ohlc.close is the LTP intraday; net_change is vs the previous close.
        prevClose: q.last_price - (q.net_change ?? 0),
        volume: q.volume ?? 0,
      }];
    });

    const shortlist = prefilter(lite, f, Math.min(MAX_CANDIDATES, Math.max(20, limit * 3)));
    const wantIntraday = f.style !== 'SWING';
    const wantDaily = f.style !== 'INTRADAY';
    const fetches = new Fetches();
    let attempted = 0;
    const candidates: ScanCandidate[] = await pool(shortlist, CANDLE_CONCURRENCY, async (q) => {
      const k = q.instrumentKey;
      attempted += (wantIntraday ? 2 : 0) + (wantDaily ? 1 : 0);
      const [hist, intra, daily] = await Promise.all([
        wantIntraday ? fetches.get(this.data.history(k), [], q.symbol) : [],
        wantIntraday ? fetches.get(this.data.intraday(k), [], q.symbol) : [],
        wantDaily ? fetches.get(this.data.daily(k), [], q.symbol) : [],
      ]);
      return { ...q, intraday: mergeCandles(hist, intra), daily };
    });
    fetches.throwIfAllFailed(attempted);

    const screened = screen(candidates, { ...f, limit }, this.clock, f.strategies?.length ? { strategies: f.strategies } : {});
    return {
      category: req.category,
      categoryName,
      listSource,
      universe: universe.length,
      quoted: lite.length,
      shortlisted: shortlist.length,
      results: screened.map((r) => ({
        symbol: r.setup.symbol,
        name: r.name,
        industry: industry.get(r.setup.instrumentKey) ?? null,
        ltp: r.ltp,
        changePct: r.changePct,
        turnoverCr: r.turnoverCr,
        atrPct: r.atrPct,
        rvol: r.rvol,
        setup: slimSetup(r.setup)!,
      })),
      entryWindowOpen: this.inEntryWindow(),
      warnings: fetches.failures.length
        ? [`${fetches.failures.length} of ${attempted} candle requests failed; affected stocks were scored on partial data`, ...fetches.warnings()]
        : [],
      durationMs: this.clock.ms() - started,
      asOf: this.clock.ms(),
    };
  }

  // ─────────────────────────── single stock, realtime ───────────────────────────

  private inEntryWindow(): boolean {
    const now = this.clock.now();
    const m = istMinutes(now);
    return marketOpenAt(now) && m >= SESSION.ENTRY_START && m < SESSION.ENTRY_END;
  }

  private async resolve(symbol: string) {
    const eq = (await this.data.master()).bySymbol.get(symbol.trim().toUpperCase());
    if (!eq) throw new MarketError(404, 'unknown_symbol', `${symbol} is not an NSE EQ-series stock`);
    return eq;
  }

  /** Every strategy on one stock, including the still-forming 5-minute bar. */
  private async analyzeLive(symbol: string, strategies?: readonly string[]) {
    const eq = await this.resolve(symbol);
    const key = eq.instrumentKey;
    const fetches = new Fetches();
    const [quotes, intra, hist, daily] = await Promise.all([
      this.data.quotes([key]),
      fetches.get(this.data.intraday(key), [], 'intraday candles'),
      fetches.get(this.data.history(key), [], 'prior-session candles'),
      fetches.get(this.data.daily(key), [], 'daily candles'),
    ]);
    fetches.throwIfAllFailed(3);
    const q = quotes.get(key) ?? null;
    const ltp = q?.last_price ?? null;
    const open = marketOpenAt(this.clock.now());
    const forming = open ? await this.data.formingBar(key, ltp).catch(() => null) : null;
    const intraday = mergeCandles(hist, intra, forming ? [forming] : []);
    const r = analyzeHybrid(
      { instrumentKey: key, symbol: eq.symbol, intraday, daily, clock: this.clock },
      strategies?.length ? { strategies } : {},
    );
    return { eq, q, ltp, open, forming, intra, intraday, daily, r, warnings: fetches.warnings() };
  }

  async stock(symbol: string, strategies?: readonly string[]) {
    const a = await this.analyzeLive(symbol, strategies);
    const { eq, q, ltp, intraday, daily, r } = a;
    const today = istDateKey(this.clock.now());
    const todayBars = intraday.filter((c) => istDateKey(new Date(c.ts)) === today);
    const c5 = closes(intraday);
    const cD = closes(daily);
    const year = daily.slice(-250);
    const price = ltp ?? intraday.at(-1)?.close ?? daily.at(-1)?.close ?? null;
    const ema50 = latest(ema(cD, 50)), ema200 = latest(ema(cD, 200));
    const change = q?.net_change ?? null;
    const prevClose = ltp !== null && change !== null ? ltp - change : null;
    const def = (id: string) => STRATEGY_CATALOG.find((d) => d.id === id);

    return {
      symbol: eq.symbol,
      name: eq.name,
      instrumentKey: eq.instrumentKey,
      asOf: this.clock.ms(),
      marketOpen: a.open,
      entryWindowOpen: this.inEntryWindow(),
      quote: {
        ltp,
        change,
        changePct: prevClose ? round((change! / prevClose) * 100) : null,
        open: q?.ohlc?.open ?? null,
        high: q?.ohlc?.high ?? null,
        low: q?.ohlc?.low ?? null,
        prevClose: round(prevClose),
        volume: q?.volume ?? null,
      },
      bars: { today: todayBars.length, warmup: intraday.length - todayBars.length, daily: daily.length, forming: a.forming !== null },
      warnings: a.warnings,
      indicators: {
        intraday: {
          rsi14: round(latest(rsi(c5, 14)), 1),
          atr14: round(latest(atr(intraday, 14))),
          vwap: round(sessionVwap(todayBars)),
          supertrend: supertrend(intraday, 10, 3).direction.at(-1) === 1 ? 'BULLISH' : 'BEARISH',
          rvol: round(latest(relativeVolume(intraday, 20))),
        },
        daily: {
          rsi14: round(latest(rsi(cD, 14)), 1),
          ema20: round(latest(ema(cD, 20))),
          ema50: round(ema50),
          ema200: round(ema200),
          adx14: round(latest(adx(daily, 14).adx), 1),
          atr14: round(latest(atr(daily, 14))),
          high52w: year.length ? Math.max(...year.map((c) => c.high)) : null,
          low52w: year.length ? Math.min(...year.map((c) => c.low)) : null,
          trend: price === null || ema50 === null || ema200 === null ? 'UNKNOWN'
            : price > ema50 && ema50 > ema200 ? 'UPTREND'
              : price < ema50 && ema50 < ema200 ? 'DOWNTREND' : 'MIXED',
        },
      },
      votes: r.votes.map((v) => ({
        strategyId: v.strategyId,
        name: v.name,
        style: v.style,
        timeframe: def(v.strategyId)?.timeframe ?? null,
        side: v.side,
        confidence: v.confidence,
        reasons: v.reasons,
        entry: v.signal ? paiseToRupees(v.signal.entry) : null,
        stopLoss: v.signal ? paiseToRupees(v.signal.stopLoss) : null,
        target: v.signal ? paiseToRupees(v.signal.target) : null,
      })),
      best: { INTRADAY: slimSetup(r.best.INTRADAY), SWING: slimSetup(r.best.SWING) },
      chart: todayBars.map((c) => [c.ts, c.open, c.high, c.low, c.close, c.volume] as const),
    };
  }

  /**
   * Each strategy's record on this stock with default parameters and costs —
   * "backtest the stock before trading it". Sample sizes come with it: a
   * handful of trades is an anecdote, not an edge.
   */
  async stockEdge(symbol: string) {
    const eq = await this.resolve(symbol);
    const key = eq.instrumentKey;
    return this.cache.get(`edge:${key}:${istDateKey(this.clock.now())}`, 30 * 60_000, async () => {
      const day = (n: number) => istDateKey(new Date(this.clock.ms() + n * DAY));
      const [daily, five] = await Promise.all([
        this.data.daily(key),
        // Upstox caps 5-minute history at 30 days per request; backfill chunks it.
        backfill(this.data.client, key, 'minutes', 5, day(-45), day(-1)).then((r) => {
          if (r.ok) return r.value;
          throw /429|rate/i.test(r.error.message)
            ? new MarketError(429, 'rate_limited', 'Upstox rate limit reached; try again in a minute')
            : new MarketError(502, 'upstox_candles', `Upstox candles: ${r.error.message}`);
        }),
      ]);
      const edges = STRATEGY_CATALOG.map((def) => {
        const bars = def.timeframe === '5m' ? five : daily;
        if (bars.length < 60) {
          // Too little history to test on (a recent listing): unknown, not zero.
          return { strategyId: def.id, name: def.name, timeframe: def.timeframe, days: 0, trades: null, winRate: null, expectancyR: null, profitFactor: null, netPnl: null };
        }
        const trades = runBacktest(def, undefined, { symbol: eq.symbol, instrumentKey: key, candles: bars });
        const m = computeMetrics(trades, defaultBacktestFor(def).capital);
        return {
          strategyId: def.id,
          name: def.name,
          timeframe: def.timeframe,
          days: Math.round((bars.at(-1)!.ts - bars[0]!.ts) / DAY),
          trades: m.trades,
          winRate: m.trades ? round(m.winRate, 3) : null,
          expectancyR: m.trades ? round(m.expectancyR) : null,
          profitFactor: m.trades ? round(m.profitFactor) : null,
          netPnl: m.trades ? Math.round(m.netPnl) : null,
        };
      });
      return { symbol: eq.symbol, asOf: this.clock.ms(), edges };
    });
  }

  /** The AI consensus on the stock's best current setup. Cached while the setup holds. */
  async stockAi(symbol: string, strategies?: readonly string[]) {
    const { eq, r } = await this.analyzeLive(symbol, strategies);
    const setups = [r.best.INTRADAY, r.best.SWING].filter((s): s is HybridSetup => s !== null);
    const best = setups.sort((a, b) => b.quality - a.quality)[0];
    if (!best) return { symbol: eq.symbol, setup: null, consensus: null, reason: 'No strategy has a setup on this stock right now.' };
    const lead: Signal | null = best.votes.find((v) => v.strategyId === best.primaryStrategyId)?.signal ?? null;
    if (!lead) return { symbol: eq.symbol, setup: slimSetup(best), consensus: null, reason: 'Lead signal unavailable.' };
    const sig = `${eq.instrumentKey}|${best.style}|${best.side}|${best.primaryStrategyId}`;
    const consensus = await this.cache.get(`ai:${sig}`, 30_000, () => this.ai.review(lead));
    return { symbol: eq.symbol, setup: slimSetup(best), consensus, reason: null };
  }

  // ─────────────────────────────── F&O ───────────────────────────────

  async fno() {
    await this.fnoReady();
    await this.cache.get('fno:refresh', 15_000, () => this.desk.refreshAll());
    const snap = this.desk.snapshot(false) as { instrument: string; underlyings: unknown[] };
    return { source: 'vercel' as const, asOf: this.clock.ms(), instrument: snap.instrument, underlyings: snap.underlyings };
  }

  /**
   * An options setup for the dashboard. Sized at one lot for reference only:
   * real sizing depends on the engine's capital, positions and limits.
   */
  async analyzeFno(symbol: string) {
    await this.fnoReady();
    const s = await this.desk.refresh(symbol.toUpperCase(), 10_000);
    if (!s) throw new MarketError(404, 'not_on_desk', `${symbol} is not on the F&O desk`);
    if (!s.signalKey) return { analytics: s.analytics, plan: null, rejected: [s.error ?? 'no signal instrument'] };

    let scored: Awaited<ReturnType<MarketService['score']>>;
    try {
      scored = await this.score({ instrumentKey: s.signalKey, symbol: s.symbol, name: s.symbol });
    } catch (e) {
      if (e instanceof MarketError && e.code === 'not_enough_bars') {
        return { analytics: s.analytics, plan: null, rejected: [e.message] };
      }
      throw e;
    }
    const signal = this.scanner.toSignal(scored.stock, 'INTRADAY');
    const planned = await this.desk.plan(s.symbol, signal);
    if (!planned.ok) return { analytics: s.analytics, plan: null, rejected: planned.reasons };
    const plan = this.desk.view(s.symbol, signal, planned.plan, 'ANALYSIS', null, 1);
    return { analytics: s.analytics, plan, rejected: [], session: scored.session };
  }

  // ─────────────────────────────── internals ───────────────────────────────

  private fnoReady(): Promise<void> {
    // Contracts expire, so the desk reloads with the master once per IST day.
    return this.cache.get(`fno:init:${istDateKey(this.clock.now())}`, Number.POSITIVE_INFINITY, async () => {
      if (!this.desk.needsReload()) return;
      await this.desk.init((await this.data.master()).contracts);
    });
  }

  private async score(item: UniverseItem): Promise<{ stock: ScoredStock & { tradeSetup: NonNullable<ScoredStock['tradeSetup']> }; session: Session }> {
    const b = (await this.rankingBarsFor([item.instrumentKey])).get(item.instrumentKey);
    const stock = b ? this.scanner.rankUniverse([item], new Map([[item.instrumentKey, b.candles]]))[0] : undefined;
    if (!b || !stock?.tradeSetup) {
      throw new MarketError(404, 'not_enough_bars', `not enough candles to analyse ${item.symbol} (${b?.candles.length ?? 0})`);
    }
    return { stock: { ...stock, tradeSetup: stock.tradeSetup }, session: b.session };
  }

  /** Ranking bars per instrument. A failed fetch drops that instrument rather than the whole page. */
  private async rankingBarsFor(keys: readonly string[]) {
    const out = new Map<string, Awaited<ReturnType<MarketData['rankingBars']>>>();
    const settled = await Promise.allSettled(keys.map(async (k) => [k, await this.data.rankingBars(k)] as const));
    for (const s of settled) if (s.status === 'fulfilled') out.set(s.value[0], s.value[1]);
    if (out.size === 0 && keys.length > 0) {
      const first = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      throw first?.reason instanceof Error ? first.reason : new MarketError(502, 'upstox_candles', 'no candles');
    }
    return out;
  }
}

/** The session most instruments were ranked on, for the dashboard label. */
function sessionOf(bars: Iterable<{ session: Session }>): Session | null {
  let pick: Session | null = null;
  for (const b of bars) {
    if (b.session.kind === 'today') return b.session;
    pick ??= b.session;
  }
  return pick;
}
