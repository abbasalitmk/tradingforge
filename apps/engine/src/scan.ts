import { istDateKey, type Clock } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import type { EquityInstrument } from '@tradeforger/fno';
import {
  prefilter, screen, getStrategy, type QuoteLite, type ScanCandidate, type ScanFilters, type ScanResult, type Params,
} from '@tradeforger/strategy';
import { runBacktest, computeMetrics, defaultBacktestFor } from '@tradeforger/backtest';
import { backfill } from '@tradeforger/data';
import type { Candle } from '@tradeforger/core';

/**
 * The lead strategy's record on THIS stock over recent history — "backtest the
 * stock before trading it". Shown with its sample size: a 4-trade record is an
 * anecdote and the dashboard says so.
 */
export interface SymbolEdge {
  readonly strategyId: string;
  readonly days: number;
  readonly trades: number;
  readonly winRate: number;
  readonly expectancyR: number;
  readonly profitFactor: number;
}
import { mergeCandles } from './live.ts';

export interface ScanJob {
  readonly id: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  readonly filters: ScanFilters;
  readonly startedAt: number;
  finishedAt: number | null;
  stage: 'QUOTES' | 'CANDLES' | 'ANALYSIS' | 'DONE';
  done: number;
  total: number;
  universe: number;
  prefiltered: number;
  results: Array<ScanResult & { edge: SymbolEdge | null }>;
  error: string | null;
}

const DAY = 86_400_000;

/**
 * Two-stage full-market scan (docs/00-PLAN.md §5.4).
 *
 *  1. Coarse — every NSE EQ-series stock through batch quotes, 500 per call:
 *     price band, volume, turnover, change. Cheap, whole-market.
 *  2. Fine — candles for the survivors (prior sessions + today 5-min, and a
 *     year of dailies), then every catalog strategy through the hybrid
 *     ensemble, ranked by setup quality.
 *
 * Read-only: a scan never places an order. Runs as a background job so the
 * trading loop never waits on it.
 */
export class MarketScanner {
  private readonly client: UpstoxClient;
  private readonly clock: Clock;
  private readonly equities: () => readonly EquityInstrument[];
  private readonly params: () => Readonly<Record<string, Params>>;
  current: ScanJob | null = null;
  private seq = 0;

  constructor(opts: {
    client: UpstoxClient; clock: Clock;
    equities: () => readonly EquityInstrument[];
    params: () => Readonly<Record<string, Params>>;
  }) {
    this.client = opts.client;
    this.clock = opts.clock;
    this.equities = opts.equities;
    this.params = opts.params;
  }

  start(filters: ScanFilters): { ok: true; job: ScanJob } | { ok: false; error: string } {
    if (this.current?.status === 'RUNNING') return { ok: false, error: 'a scan is already running' };
    const universe = this.equities();
    if (universe.length === 0) return { ok: false, error: 'equity master not loaded' };
    this.seq += 1;
    const job: ScanJob = {
      id: `scan-${this.clock.ms()}-${this.seq}`, status: 'RUNNING', filters, startedAt: this.clock.ms(),
      finishedAt: null, stage: 'QUOTES', done: 0, total: Math.ceil(universe.length / 500),
      universe: universe.length, prefiltered: 0, results: [], error: null,
    };
    this.current = job;
    void this.run(job, universe).catch((e) => {
      job.status = 'FAILED';
      job.error = e instanceof Error ? e.message : String(e);
      job.finishedAt = this.clock.ms();
    });
    return { ok: true, job };
  }

  private async run(job: ScanJob, universe: readonly EquityInstrument[]): Promise<void> {
    const byKey = new Map(universe.map((e) => [e.instrumentKey, e]));
    const quotes: QuoteLite[] = [];
    for (let i = 0; i < universe.length; i += 500) {
      const keys = universe.slice(i, i + 500).map((e) => e.instrumentKey);
      const r = await this.client.quotes(keys);
      if (!r.ok) throw new Error(`quotes: ${r.error.message}`);
      for (const q of r.value) {
        const eq = byKey.get(q.instrument_token);
        if (!eq || !(q.last_price > 0)) continue;
        quotes.push({
          instrumentKey: q.instrument_token, symbol: eq.symbol, name: eq.name, ltp: q.last_price,
          open: q.ohlc?.open ?? q.last_price, high: q.ohlc?.high ?? q.last_price, low: q.ohlc?.low ?? q.last_price,
          // The quote's ohlc.close is the LTP intraday; net_change is vs the previous close.
          prevClose: q.last_price - (q.net_change ?? 0),
          volume: q.volume ?? 0,
        });
      }
      job.done += 1;
    }

    const limit = job.filters.limit ?? 25;
    const shortlist = prefilter(quotes, job.filters, Math.min(80, Math.max(20, limit * 3)));
    job.prefiltered = shortlist.length;
    job.stage = 'CANDLES';
    job.done = 0;
    job.total = shortlist.length;

    const today = istDateKey(this.clock.now());
    const weekAgo = istDateKey(new Date(this.clock.ms() - 8 * DAY));
    const yesterday = istDateKey(new Date(this.clock.ms() - DAY));
    const yearAgo = istDateKey(new Date(this.clock.ms() - 400 * DAY));
    const wantIntraday = job.filters.style !== 'SWING';
    const wantDaily = job.filters.style !== 'INTRADAY';

    const candidates: ScanCandidate[] = [];
    for (const q of shortlist) {
      const [hist, intra, daily] = await Promise.all([
        wantIntraday ? this.client.historicalCandles(q.instrumentKey, 'minutes', 5, yesterday, weekAgo) : null,
        wantIntraday ? this.client.intradayCandles(q.instrumentKey, 'minutes', 5) : null,
        wantDaily ? this.client.historicalCandles(q.instrumentKey, 'days', 1, today, yearAgo) : null,
      ]);
      candidates.push({
        ...q,
        intraday: mergeCandles(hist?.ok ? hist.value : [], intra?.ok ? intra.value : []),
        daily: daily?.ok ? daily.value : [],
      });
      job.done += 1;
    }

    job.stage = 'ANALYSIS';
    const screened = screen(candidates, job.filters, this.clock, { params: this.params(), ...(job.filters.strategies?.length ? { strategies: job.filters.strategies } : {}) });

    // Per-stock edge for the survivors: 30 sessions of 5-min bars for intraday
    // leads (one extra request each), the year of dailies already in hand for swing.
    const monthAgo = istDateKey(new Date(this.clock.ms() - 45 * DAY));
    const params = this.params();
    job.results = [];
    for (const r of screened) {
      const def = getStrategy(r.setup.primaryStrategyId);
      let edge: SymbolEdge | null = null;
      if (def) {
        let bars: readonly Candle[] = candidates.find((c) => c.instrumentKey === r.setup.instrumentKey)?.daily ?? [];
        if (def.timeframe === '5m') {
          // Upstox caps 5-min history at 30 days per request; backfill chunks it.
          const h = await backfill(this.client, r.setup.instrumentKey, 'minutes', 5, monthAgo, yesterday);
          bars = h.ok ? h.value : [];
        }
        if (bars.length > 0) {
          const trades = runBacktest(def, params[def.id], { symbol: r.setup.symbol, instrumentKey: r.setup.instrumentKey, candles: bars });
          const m = computeMetrics(trades, defaultBacktestFor(def).capital);
          edge = {
            strategyId: def.id,
            days: Math.round((bars[bars.length - 1]!.ts - bars[0]!.ts) / DAY),
            trades: m.trades, winRate: m.winRate, expectancyR: m.expectancyR, profitFactor: m.profitFactor,
          };
        }
      }
      job.results.push({ ...r, edge });
    }
    job.stage = 'DONE';
    job.status = 'DONE';
    job.finishedAt = this.clock.ms();
  }
}
