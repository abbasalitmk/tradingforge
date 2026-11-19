import { type Candle, type Clock, istDateKey } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { StockScanner, DEFAULT_UNIVERSE, type ScoredStock, type UniverseItem } from '@tradeforger/strategy';
import type { AiReviewer } from '@tradeforger/ai';
import { FnoDesk, DEFAULT_OPTION_PLAN, type DerivativeContract } from '@tradeforger/fno';
import { TtlCache } from './cache.ts';

/** The scanner needs this many 5-minute bars before it will score a stock. */
const MIN_BARS = 15;

const TTL = {
  quotes: 5_000,
  intraday: 60_000,
  previousSession: 10 * 60_000,
  fnoRefresh: 15_000,
} as const;

export class MarketError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Which session the bars came from: today's, or the last full one when today has too few. */
export interface Session {
  readonly kind: 'today' | 'previous';
  readonly date: string;
}

interface Bars {
  readonly candles: readonly Candle[];
  readonly session: Session;
}

export interface MarketDeps {
  readonly client: UpstoxClient;
  readonly clock: Clock;
  readonly ai: AiReviewer;
  readonly fnoSymbols?: readonly string[];
  /** Injected in tests; production downloads the Upstox instrument master. */
  readonly loadContracts?: () => Promise<readonly DerivativeContract[]>;
}

/**
 * Read-only market analysis for the dashboard, independent of the engine.
 *
 * Runs on the analytics token alone, so it works from any IP and can never
 * place an order. Mirrors the engine's own analysis paths (/state ranking,
 * /scanner/analyze, /fno/analyze) so both show the same picture.
 */
export class MarketService {
  private readonly client: UpstoxClient;
  private readonly clock: Clock;
  private readonly ai: AiReviewer;
  private readonly scanner = new StockScanner();
  private readonly cache: TtlCache;
  private readonly desk: FnoDesk;
  private readonly loadContracts: (() => Promise<readonly DerivativeContract[]>) | undefined;

  constructor(deps: MarketDeps) {
    this.client = deps.client;
    this.clock = deps.clock;
    this.ai = deps.ai;
    this.loadContracts = deps.loadContracts;
    this.cache = new TtlCache(() => deps.clock.ms());
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

  // ─────────────────────────────── equities ───────────────────────────────

  async overview() {
    const keys = DEFAULT_UNIVERSE.map((u) => u.instrumentKey);
    const [quotes, bars] = await Promise.all([this.quotes(keys), this.barsFor(keys)]);
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
    const item = DEFAULT_UNIVERSE.find((u) => u.symbol === symbol.toUpperCase());
    if (!item) throw new MarketError(404, 'not_in_universe', `${symbol} is not in the universe`);
    const { stock, session } = await this.score(item);
    const signal = this.scanner.toSignal(stock, style);
    const consensus = await this.ai.review(signal);
    return { stock, tradeSetup: stock.tradeSetup, signal, consensus, votes: consensus.votes, session };
  }

  // ─────────────────────────────── F&O ───────────────────────────────

  async fno() {
    await this.fnoReady();
    await this.cache.get('fno:refresh', TTL.fnoRefresh, () => this.desk.refreshAll());
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
    // Contracts expire, so the master is reloaded once per IST day.
    return this.cache.get(`fno:init:${istDateKey(this.clock.now())}`, Number.POSITIVE_INFINITY, async () => {
      if (!this.desk.needsReload()) return;
      await this.desk.init(this.loadContracts ? await this.loadContracts() : undefined);
    });
  }

  private async score(item: UniverseItem): Promise<{ stock: ScoredStock & { tradeSetup: NonNullable<ScoredStock['tradeSetup']> }; session: Session }> {
    const b = (await this.barsFor([item.instrumentKey])).get(item.instrumentKey);
    const stock = b ? this.scanner.rankUniverse([item], new Map([[item.instrumentKey, b.candles]]))[0] : undefined;
    if (!b || !stock?.tradeSetup) {
      throw new MarketError(404, 'not_enough_bars', `not enough candles to analyse ${item.symbol} (${b?.candles.length ?? 0})`);
    }
    return { stock: { ...stock, tradeSetup: stock.tradeSetup }, session: b.session };
  }

  private quotes(keys: readonly string[]) {
    return this.cache.get(`quotes:${keys.join(',')}`, TTL.quotes, async () => {
      const r = await this.client.quotes(keys);
      if (!r.ok) throw new MarketError(502, 'upstox_quotes', `Upstox quotes: ${r.error.message}`);
      return new Map(r.value.map((q) => [q.instrument_token, q]));
    });
  }

  /** Bars per instrument. A failed fetch drops that instrument rather than the whole page. */
  private async barsFor(keys: readonly string[]): Promise<Map<string, Bars>> {
    const out = new Map<string, Bars>();
    const settled = await Promise.allSettled(keys.map(async (k) => [k, await this.bars(k)] as const));
    for (const s of settled) if (s.status === 'fulfilled') out.set(s.value[0], s.value[1]);
    if (out.size === 0 && keys.length > 0) {
      const first = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      throw first?.reason instanceof Error ? first.reason : new MarketError(502, 'upstox_candles', 'no candles');
    }
    return out;
  }

  private async bars(key: string): Promise<Bars> {
    const today = istDateKey(this.clock.now());
    const intra = await this.cache.get(`intraday:${key}`, TTL.intraday, async () => {
      const r = await this.client.intradayCandles(key, 'minutes', 5);
      if (!r.ok) throw new MarketError(502, 'upstox_candles', `Upstox candles: ${r.error.message}`);
      return r.value;
    });
    if (intra.length >= MIN_BARS) return { candles: intra, session: { kind: 'today', date: today } };

    // Before ~10:30, at weekends and on holidays today has too few bars:
    // rank on the last full session instead, and say so.
    return this.cache.get(`previous:${key}:${today}`, TTL.previousSession, async () => {
      const weekAgo = istDateKey(new Date(this.clock.ms() - 8 * 86_400_000));
      const yesterday = istDateKey(new Date(this.clock.ms() - 86_400_000));
      const r = await this.client.historicalCandles(key, 'minutes', 5, yesterday, weekAgo);
      if (!r.ok) throw new MarketError(502, 'upstox_candles', `Upstox candles: ${r.error.message}`);
      const last = r.value.at(-1);
      if (!last) return { candles: intra, session: { kind: 'today', date: today } } satisfies Bars;
      const date = istDateKey(new Date(last.ts));
      return {
        candles: r.value.filter((c) => istDateKey(new Date(c.ts)) === date),
        session: { kind: 'previous', date },
      } satisfies Bars;
    });
  }
}

/** The session most instruments were ranked on, for the dashboard label. */
function sessionOf(bars: Iterable<Bars>): Session | null {
  let pick: Session | null = null;
  for (const b of bars) {
    if (b.session.kind === 'today') return b.session;
    pick ??= b.session;
  }
  return pick;
}
