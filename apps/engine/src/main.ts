import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  SystemClock, istHHMM, istDateKey, istMinutes, SESSION, rupeesToPaise, paiseToRupees,
  type Paise, type Candle, type Tick, type Side, type Signal, type SizingMode, type Mode, type Product, pctOf,
} from '@tradeforger/core';
import { db, audit, closeDb } from '@tradeforger/db';
import { TokenStore, UpstoxClient } from '@tradeforger/upstox';
import { PaperBroker, UpstoxBroker, type BrokerPort } from '@tradeforger/broker';
import {
  evaluate, effectiveMode, fire, canEnterLive, armUntilSessionEnd,
  type RiskSnapshot, type KillLevel,
} from '@tradeforger/safety';
import { MarketFeed, PortfolioFeed } from '@tradeforger/feed';
import { CandleAggregator } from '@tradeforger/data';
import { size as sizePosition } from '@tradeforger/risk';
import { PositionMachine } from '@tradeforger/execution';
import {
  StrategyManager, type AutoTradingStrategyMode, IntradayProfile, SwingProfile, StockScanner, DEFAULT_UNIVERSE,
} from '@tradeforger/strategy';
import { AiReviewer, type AiDecision } from '@tradeforger/ai';
import {
  DEFAULT_OPTION_PLAN, DEFAULT_STRIKE_PARAMS, fetchMasterRows, parseMaster, parseEquities, FnoDesk,
  type FnoPlan, type FnoPlanView, type DerivativeContract, type EquityInstrument,
} from '@tradeforger/fno';
import { STRATEGY_CATALOG, type ScanFilters } from '@tradeforger/strategy';
import { loadConfig, LIVE_CONFIRMATION, type EngineConfig } from './config.ts';
import { preflight } from './preflight.ts';
import { Trader, type ManagedPosition } from './trader.ts';
import { StrategyRegistry } from './registry.ts';
import { TradeMemory } from './memory.ts';
import { LiveAnalyzer, AutoConfigSchema, DEFAULT_AUTO, mergeCandles, type AutoConfig, type LiveAnalysis, type LiveSetup, type Target } from './live.ts';
import { MarketScanner } from './scan.ts';
import { ResearchLab } from './research.ts';

const clock = SystemClock;
let cfg: EngineConfig;
try {
  cfg = loadConfig();
} catch (e) {
  console.error('[Config Error]', e instanceof Error ? e.message : e);
  process.exit(1);
}

const sql = db(cfg.DATABASE_URL);

const tokens = new TokenStore(clock, {
  ...(cfg.UPSTOX_ANALYTICS_TOKEN ? { analyticsToken: cfg.UPSTOX_ANALYTICS_TOKEN } : {}),
});

/** `exp` claim of a JWT in ms, or null when it cannot be read. */
function jwtExpiryMs(token: string): number | null {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())?.exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// A token left in .env.local outlives its day, so trust its own expiry
// rather than letting setTrading() assume it is good until the next 03:30.
if (cfg.UPSTOX_ACCESS_TOKEN) {
  const exp = jwtExpiryMs(cfg.UPSTOX_ACCESS_TOKEN);
  if (exp !== null && exp > clock.ms()) tokens.setTrading(cfg.UPSTOX_ACCESS_TOKEN);
  else console.warn('UPSTOX_ACCESS_TOKEN is expired or unreadable — ignored; log in with Upstox from the dashboard');
}

const client = new UpstoxClient(tokens, {
  clock,
  onHalt: (e) => {
    console.error(`[HALT] ${e.kind}: ${e.message}`);
    state.manualHalt = true;
  },
});

const strategyManager = new StrategyManager({
  clock,
  mode: cfg.TF_AUTO_TRADING_MODE,
  intradayProfile: new IntradayProfile(),
  swingProfile: new SwingProfile(),
});
const stockScanner = new StockScanner();

const aiReviewer = new AiReviewer({
  clock,
  groqConfig: cfg.GROQ_API_KEY
    ? { apiKey: cfg.GROQ_API_KEY, model: cfg.GROQ_MODEL, baseUrl: cfg.GROQ_BASE_URL, timeoutMs: 900 }
    : null,
});

// ─────────────────────────────── runtime state ───────────────────────────────

/** Whether this process talks to Upstox for orders at all. Fixed at boot. */
const wantsLiveBroker = cfg.TF_MODE === 'LIVE' || cfg.TF_MODE === 'LIVE_ARMED';

const state = {
  // LIVE is never reached at boot: it takes an explicit, expiring arm.
  arm: {
    mode: (wantsLiveBroker ? 'LIVE_ARMED' : 'PAPER') as Mode,
    armedUntilMs: null as number | null,
    armedBy: null as string | null,
  },
  /** Autonomous entry settings — user-editable from the dashboard. */
  auto: {
    ...DEFAULT_AUTO,
    enabled: cfg.TF_AUTO_ENABLED,
    minQuality: cfg.TF_AUTO_MIN_QUALITY,
    minRewardRisk: cfg.TF_AUTO_MIN_RR,
  } as AutoConfig,
  autoEntries: { day: '', count: 0 },
  /** The single stock the dashboard is analysing in real time. */
  focus: null as { instrumentKey: string; symbol: string } | null,
  fnoEnabled: cfg.TF_FNO_ENABLED,
  strategyMode: cfg.TF_AUTO_TRADING_MODE as AutoTradingStrategyMode,
  sizingMode: cfg.TF_SIZING_MODE as SizingMode,
  budget: cfg.TF_BUDGET,
  fixedQty: cfg.TF_FIXED_QTY ?? 10,
  riskPct: cfg.TF_RISK_PCT,
  manualHalt: false,
  startedAt: clock.ms(),
  ticks: 0,
  lastTickMs: null as number | null,
  signalsCount: 0,
};

const currentMode = (): Mode => effectiveMode(state.arm, clock);

// Core universe of liquid NSE equities
export interface WatchlistStock {
  instrumentKey: string;
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lastUpdated: number;
}


const watchlist = new Map<string, WatchlistStock>();
for (const s of DEFAULT_UNIVERSE) {
  watchlist.set(s.instrumentKey, {
    ...s, ltp: 0, changePct: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, lastUpdated: clock.ms(),
  });
}

/** Last traded price for every instrument we hear about — equities, futures, options, indices. */
const lastLtp = new Map<string, number>();
const ltpOf = (key: string): number | null => lastLtp.get(key) ?? null;

const aggregator5m = new CandleAggregator(5);
const intradayCandlesCache = new Map<string, Candle[]>();
/** Prior sessions' 5-min bars: indicator warmup for the morning, never traded on. */
const historyCache = new Map<string, Candle[]>();
const dailyCandlesCache = new Map<string, Candle[]>();

export interface SignalWithAi {
  readonly id: string;
  readonly instrumentKey: string;
  readonly symbol: string;
  readonly style: 'INTRADAY' | 'SWING';
  readonly side: Side;
  readonly entry: Paise;
  readonly stopLoss: Paise;
  readonly target: Paise;
  readonly confidence: number;
  readonly reasons: readonly string[];
  readonly ai: AiDecision;
  readonly generatedAt: number;
}
const recentSignals: SignalWithAi[] = [];

const fnoDesk = new FnoDesk({
  client,
  clock,
  ltpOf,
  settings: {
    symbols: cfg.TF_FNO_UNDERLYINGS,
    instrument: cfg.TF_FNO_INSTRUMENT,
    minDte: cfg.TF_FNO_MIN_DTE,
    refreshMs: cfg.TF_FNO_CHAIN_REFRESH_SEC * 1000,
    plan: {
      ...DEFAULT_OPTION_PLAN,
      maxPremiumLossPct: cfg.TF_FNO_MAX_PREMIUM_LOSS_PCT,
      maxIv: cfg.TF_FNO_MAX_IV,
      strike: {
        ...DEFAULT_STRIKE_PARAMS,
        targetDelta: cfg.TF_FNO_TARGET_DELTA,
        maxSpreadPct: cfg.TF_FNO_MAX_SPREAD_PCT,
      },
    },
  },
});

const positionMachine = new PositionMachine(async (p, from, to) => {
  await audit(sql, {
    kind: 'STATE_TRANSITION',
    actor: 'engine',
    mode: currentMode(),
    positionId: p.id,
    payload: { symbol: p.symbol, from, to, qty: p.quantity, filled: p.filledQuantity },
  });
});

const paperBroker = new PaperBroker(clock);
let upstoxBroker: UpstoxBroker | null = null;
let broker: BrokerPort = paperBroker;
let trader!: Trader;

function ensureUpstoxBroker(): UpstoxBroker {
  if (!upstoxBroker) {
    upstoxBroker = new UpstoxBroker({
      client,
      clock,
      modeGate: currentMode,
      onDryRun: (kind, payload) => {
        console.log(`[DRY RUN ${currentMode()}] ${kind}`, JSON.stringify(payload));
        void audit(sql, { kind: 'ORDER_REQUEST', actor: 'engine', mode: currentMode(), payload: { dryRun: true, kind, payload: payload as never } });
      },
    });
  }
  return upstoxBroker;
}

// ─────────────────────────────── risk snapshot ───────────────────────────────

function unrealisedTotal(): Paise {
  return trader.live().reduce((s, p) => s + trader.unrealised(p, ltpOf(p.instrumentKey)), 0) as Paise;
}

function snapshot(): RiskSnapshot {
  let worst = 0;
  for (const p of trader.live()) {
    worst = Math.min(worst, trader.unrealised(p, ltpOf(p.instrumentKey)));
  }
  return {
    startingCapitalPaise: rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL),
    realisedPnlPaise: trader.realisedPnl,
    unrealisedPnlPaise: unrealisedTotal(),
    openPositions: trader.live().length,
    ordersToday: trader.ordersToday,
    consecutiveLosses: trader.consecutiveLosses,
    rejectsLast5Min: trader.rejectsLast5Min,
    orderTimestamps: trader.orderTimestamps,
    lastTickMs: state.lastTickMs,
    marginUtilisationPct: 0,
    // An ORPHANED position is an engine/broker disagreement by definition.
    divergenceDetected: trader.hasOrphan(),
    manualHalt: state.manualHalt,
    worstOpenLossPaise: Math.abs(worst) as Paise,
  };
}

const verdictNow = () => evaluate(snapshot(), cfg.limits, clock);

// ─────────────────────────────── market feed ───────────────────────────────

const feed = new MarketFeed(async () => {
  const r = await client.marketFeedUrl();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, clock);

feed.on('tick', (t: Tick) => {
  state.ticks++;
  state.lastTickMs = clock.ms();
  lastLtp.set(t.instrumentKey, t.ltp);
  if (broker === paperBroker) paperBroker.onTick(t);

  const stock = watchlist.get(t.instrumentKey);
  if (stock) {
    stock.ltp = t.ltp;
    stock.volume = t.volume ?? stock.volume;
    if (stock.open === 0) stock.open = t.ltp;
    if (stock.high === 0 || t.ltp > stock.high) stock.high = t.ltp;
    if (stock.low === 0 || t.ltp < stock.low) stock.low = t.ltp;
    if (t.close && t.close > 0) {
      stock.close = t.close;
      stock.changePct = ((t.ltp - t.close) / t.close) * 100;
    } else if (stock.close > 0) {
      stock.changePct = ((t.ltp - stock.close) / stock.close) * 100;
    }
    stock.lastUpdated = clock.ms();
  }

  const closed = aggregator5m.push(t);
  if (closed) {
    const arr = intradayCandlesCache.get(t.instrumentKey) ?? [];
    arr.push(closed);
    if (arr.length > 120) arr.shift();
    intradayCandlesCache.set(t.instrumentKey, arr);

    // Entries are decided by the 2-second live loop (liveCycle), not here.
  }
});

feed.on('error', (e) => console.error('[feed]', e.message));
feed.on('open', () => {
  const keys = [...new Set([...watchlist.keys(), ...fnoDesk.feedKeys(), ...trader.live().map((p) => p.instrumentKey)])];
  const { accepted, rejected } = feed.subscribe(keys, 'full');
  console.log(`[feed] connected — subscribed ${accepted.length} instruments, rejected ${rejected.length}`);
});
feed.on('close', (c, r) => console.warn(`[feed] closed ${c} ${r}`));

// The second (and last) WebSocket the standard tier allows. Live only.
const portfolioFeed = new PortfolioFeed(async () => {
  const r = await client.portfolioFeedUrl();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, clock);
portfolioFeed.on('order', () => void broker.sync());
portfolioFeed.on('gtt', () => void broker.sync());
portfolioFeed.on('error', (e: Error) => console.error('[portfolio feed]', e.message));
let portfolioFeedStarted = false;

async function startPortfolioFeed(): Promise<void> {
  if (portfolioFeedStarted || broker === paperBroker || tokens.trading() === null) return;
  portfolioFeedStarted = true;
  try {
    await portfolioFeed.connect();
  } catch (e) {
    portfolioFeedStarted = false;
    console.error('[portfolio feed] connect failed', e instanceof Error ? e.message : e);
  }
}

/** Real quote for an instrument the feed has not ticked yet (a freshly chosen option). */
async function primePrice(instrumentKey: string): Promise<number | null> {
  const r = await client.ltp([instrumentKey]);
  if (!r.ok) return null;
  const q = Object.values(r.value).find((x) => x.instrument_token === instrumentKey) ?? Object.values(r.value)[0];
  if (!q || !(q.last_price > 0)) return null;
  lastLtp.set(instrumentKey, q.last_price);
  if (broker === paperBroker) paperBroker.onTick({ instrumentKey, ltp: q.last_price, ts: clock.ms() });
  return q.last_price;
}

function onPositionClosed(p: ManagedPosition): void {
  void memory.record(p, currentMode());
  void audit(sql, {
    kind: 'POSITION_CLOSED',
    actor: 'engine',
    mode: currentMode(),
    positionId: p.id,
    payload: {
      symbol: p.contract?.tradingSymbol ?? p.symbol,
      segment: p.segment,
      reason: p.exitReason,
      exit: p.exitPrice !== null ? paiseToRupees(p.exitPrice) : null,
      pnl: p.realisedPnl !== null ? paiseToRupees(p.realisedPnl) : null,
    },
  });
  // Option contracts are subscribed per trade; release the instrument budget.
  if (p.segment === 'FO' && !fnoDesk.feedKeys().includes(p.instrumentKey)) {
    feed.unsubscribe([p.instrumentKey]);
  }
}

// ─────────────────────────────── equity path ───────────────────────────────

async function recordSignal(signal: Signal, ai: AiDecision): Promise<void> {
  state.signalsCount++;
  recentSignals.unshift({
    id: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol,
    style: signal.style === 'SWING' ? 'SWING' : 'INTRADAY', side: signal.side,
    entry: signal.entry, stopLoss: signal.stopLoss, target: signal.target,
    confidence: signal.confidence, reasons: signal.reasons, ai, generatedAt: signal.generatedAt,
  });
  if (recentSignals.length > 50) recentSignals.pop();
  await audit(sql, {
    kind: 'SIGNAL_GENERATED',
    actor: 'engine',
    mode: currentMode(),
    signalId: signal.id,
    payload: {
      symbol: signal.symbol, style: signal.style, side: signal.side,
      entry: paiseToRupees(signal.entry), stopLoss: paiseToRupees(signal.stopLoss),
      target: paiseToRupees(signal.target), aiVerdict: ai.verdict, aiConfidence: ai.confidence,
      riskFlags: [...ai.riskFlags], rationale: ai.rationale,
    },
  });
}

interface EntryMeta {
  readonly strategyId: string;
  readonly strategyVersion?: string | undefined;
  readonly quality: number;
}
type EntryResult = { ok: true } | { ok: false; reason: string };

/**
 * Cash-segment entry for a confirmed setup: sizing, the AI size multiplier,
 * a last breaker check, then the Trader. Intraday uses product I, swing D.
 */
async function enterEquity(signal: Signal, product: Product, ai: AiDecision, meta: EntryMeta): Promise<EntryResult> {
  const key = signal.instrumentKey;
  if (trader.holds(key)) return { ok: false, reason: 'already holding' };
  if (!verdictNow().allowEntries) return { ok: false, reason: 'circuit breaker tripped' };

  const deployed = trader.deployed();
  const sized = sizePosition({
    mode: state.sizingMode,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    fixedQty: state.fixedQty,
    budget: rupeesToPaise(state.budget),
    riskPct: state.riskPct,
    capital: rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL),
    availableMargin: (rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL) - deployed) as Paise,
    lotSize: 1,
    avgDailyVolume: Math.max(watchlist.get(key)?.volume ?? 0, 50_000),
    deployedCapital: deployed,
  }, cfg.limits);
  if (!sized.ok) return { ok: false, reason: `sizing: ${sized.reason} — ${sized.detail}` };

  // CAUTION shrinks the size; it must never round a rejection up to one share.
  const qty = Math.floor(sized.result.quantity * ai.sizeMultiplier);
  if (qty < 1) return { ok: false, reason: 'AI caution reduced size below one share' };

  if (lastLtp.get(key) === undefined) await primePrice(key);
  const r = await trader.open({
    segment: 'EQ',
    style: signal.style,
    signalId: signal.id,
    instrumentKey: key,
    symbol: signal.symbol,
    side: signal.side,
    quantity: qty,
    product,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    target: signal.target,
    trailingGap: null,
    costPaise: (signal.entry * qty) as Paise,
    timeStopMin: null,
    strategyId: meta.strategyId,
    ...(meta.strategyVersion ? { strategyVersion: meta.strategyVersion } : {}),
    quality: meta.quality,
  });
  return r.ok ? { ok: true } : { ok: false, reason: r.reason };
}

// ─────────────────────────────── F&O path ───────────────────────────────

type FnoSizing = { ok: true; lots: number; qty: number; cost: Paise } | { ok: false; reason: string };

async function sizeFno(plan: FnoPlan, volume: number, aiMultiplier: number): Promise<FnoSizing> {
  const c = plan.contract;
  let costPerUnit = plan.entry;
  if (c.instrumentType === 'FUT') {
    // A futures lot locks up exchange margin, not notional. Without the real
    // number we refuse rather than guess.
    const m = await client.margin([{
      instrument_key: c.instrumentKey, quantity: c.lotSize, product: 'I',
      transaction_type: plan.side, price: paiseToRupees(plan.entry),
    }]);
    if (!m.ok || m.value.finalMargin <= 0) {
      return { ok: false, reason: `futures margin unavailable${m.ok ? '' : `: ${m.error.message}`}` };
    }
    costPerUnit = rupeesToPaise(m.value.finalMargin / c.lotSize);
  }

  const deployed = trader.deployed();
  const sized = sizePosition({
    mode: state.sizingMode,
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    // FIXED_QTY on F&O means "the maximum lots", never raw units.
    fixedQty: cfg.TF_FNO_MAX_LOTS * c.lotSize,
    budget: rupeesToPaise(state.budget),
    riskPct: state.riskPct,
    capital: rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL),
    availableMargin: (rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL) - deployed) as Paise,
    lotSize: c.lotSize,
    avgDailyVolume: volume > 0 ? volume : Number.MAX_SAFE_INTEGER,
    deployedCapital: deployed,
    costPerUnit,
    maxQuantity: Math.min(c.freezeQuantity, cfg.TF_FNO_MAX_LOTS * c.lotSize),
  }, cfg.limits);
  if (!sized.ok) return { ok: false, reason: `${sized.reason}: ${sized.detail}` };

  const lots = Math.floor((sized.result.quantity / c.lotSize) * aiMultiplier);
  if (lots < 1) return { ok: false, reason: 'AI caution reduced size below one lot' };
  return { ok: true, lots, qty: lots * c.lotSize, cost: (costPerUnit * lots * c.lotSize) as Paise };
}

/** Derivatives entry: the underlying's setup becomes an option (or futures) plan. */
async function enterFno(symbol: string, signal: Signal, ai: AiDecision, meta: EntryMeta): Promise<EntryResult> {
  if (!state.fnoEnabled) return { ok: false, reason: 'F&O desk disabled' };
  if (trader.live().some((p) => p.underlyingSymbol === symbol)) return { ok: false, reason: `already positioned in ${symbol}` };

  const planned = await fnoDesk.plan(symbol, signal);
  if (!planned.ok) {
    const reason = planned.reasons.join('; ');
    fnoDesk.record(fnoDesk.view(symbol, signal, null, 'REJECTED', reason));
    return { ok: false, reason };
  }
  const { plan } = planned;
  const sized = await sizeFno(plan, planned.volume, ai.sizeMultiplier);
  if (!sized.ok) {
    fnoDesk.record(fnoDesk.view(symbol, signal, plan, 'REJECTED', sized.reason));
    return { ok: false, reason: sized.reason };
  }
  const view = fnoDesk.record(fnoDesk.view(symbol, signal, plan, 'PLANNED', null, sized.lots));
  const fail = (reason: string): EntryResult => {
    view.status = 'REJECTED';
    view.rejectReason = reason;
    return { ok: false, reason };
  };
  if (!verdictNow().allowEntries) return fail('breaker tripped while planning');

  const c = plan.contract;
  feed.subscribe([c.instrumentKey], 'full');
  if (await primePrice(c.instrumentKey) === null) return fail(`no live quote for ${c.tradingSymbol}`);

  const r = await trader.open({
    segment: 'FO',
    style: 'INTRADAY',
    signalId: signal.id,
    instrumentKey: c.instrumentKey,
    symbol: c.tradingSymbol,
    side: plan.side,
    quantity: sized.qty,
    product: 'I',
    entry: plan.entry,
    stopLoss: plan.stopLoss,
    target: plan.target,
    trailingGap: plan.trailingGap,
    costPaise: sized.cost,
    timeStopMin: c.instrumentType !== 'FUT' && cfg.TF_FNO_TIME_STOP_MIN > 0 ? cfg.TF_FNO_TIME_STOP_MIN : null,
    contract: {
      tradingSymbol: c.tradingSymbol, instrumentType: c.instrumentType, strike: c.strike,
      expiry: c.expiry, lotSize: c.lotSize, lots: sized.lots,
    },
    underlyingSymbol: symbol,
    strategyId: meta.strategyId,
    ...(meta.strategyVersion ? { strategyVersion: meta.strategyVersion } : {}),
    quality: meta.quality,
  });
  if (!r.ok) return fail(r.reason);
  view.status = 'PLACED';
  return { ok: true };
}

/** On-demand setup for the dashboard. Never places an order. */
async function analyzeFno(symbol: string): Promise<{ analytics: unknown; plan: FnoPlanView | null; rejected: string[] }> {
  const s = await fnoDesk.refresh(symbol, 10_000);
  if (!s) return { analytics: null, plan: null, rejected: [`${symbol} is not configured on the F&O desk`] };
  const candles = intradayCandlesCache.get(s.signalKey) ?? [];
  const scored = stockScanner.rankUniverse([{ instrumentKey: s.signalKey, symbol, name: symbol }], intradayCandlesCache)[0];
  if (!scored?.tradeSetup) {
    return { analytics: s.analytics, plan: null, rejected: [`not enough candles on ${s.signalKey} (${candles.length})`] };
  }
  const signal = stockScanner.toSignal(scored, 'INTRADAY');
  const planned = await fnoDesk.plan(symbol, signal);
  if (!planned.ok) return { analytics: s.analytics, plan: null, rejected: planned.reasons };
  const sized = await sizeFno(planned.plan, planned.volume, 1);
  const view = fnoDesk.view(symbol, signal, planned.plan, 'ANALYSIS', sized.ok ? null : sized.reason, sized.ok ? sized.lots : 0);
  fnoDesk.record(view);
  return { analytics: s.analytics, plan: view, rejected: sized.ok ? [] : [sized.reason] };
}

// ──────────────────────── live analysis & autonomy ────────────────────────

const registry = new StrategyRegistry(sql);
const memory = new TradeMemory(sql);
let equities: EquityInstrument[] = [];
let masterContracts: DerivativeContract[] | null = null;

const candleSource = {
  intraday: (key: string): Candle[] =>
    mergeCandles(historyCache.get(key) ?? [], intradayCandlesCache.get(key) ?? []).slice(-400),
  partial: (key: string): Candle | null => aggregator5m.peek(key),
  daily: (key: string): Candle[] => dailyCandlesCache.get(key) ?? [],
  ltp: ltpOf,
};
const analyzer = new LiveAnalyzer(clock, candleSource);

const scanner = new MarketScanner({
  client, clock,
  equities: () => equities,
  params: () => registry.activeParams(),
});

const lab = new ResearchLab({
  client, clock, registry,
  ai: cfg.GROQ_API_KEY ? { apiKey: cfg.GROQ_API_KEY, model: cfg.GROQ_MODEL, baseUrl: cfg.GROQ_BASE_URL } : null,
  // Liquid, long-history names: research needs continuous data, so no futures.
  symbols: () => DEFAULT_UNIVERSE.slice(0, 6).map((u) => ({ instrumentKey: u.instrumentKey, symbol: u.symbol })),
});

interface AutoLogEntry {
  readonly at: number;
  readonly symbol: string;
  readonly style: string;
  readonly side: Side;
  readonly route: string;
  readonly quality: number;
  readonly strategyId: string;
  readonly outcome: 'PLACED' | 'REJECTED' | 'AI_BLOCKED';
  readonly detail: string;
}
const autoLog: AutoLogEntry[] = [];
const cooldown = new Map<string, number>();
let acting = false;

/** What the loop analyses: the watchlist, the F&O underlyings, and the focus stock. */
function targets(): Target[] {
  const map = new Map<string, Target>();
  for (const w of watchlist.values()) {
    const desk = state.fnoEnabled ? fnoDesk.states.get(w.symbol) : undefined;
    map.set(w.instrumentKey, {
      instrumentKey: w.instrumentKey, symbol: w.symbol, cashTradeable: true,
      fnoUnderlying: desk?.signalKey === w.instrumentKey,
    });
  }
  if (state.fnoEnabled) {
    for (const d of fnoDesk.states.values()) {
      if (!d.signalKey || map.has(d.signalKey)) continue;
      map.set(d.signalKey, {
        instrumentKey: d.signalKey, symbol: d.symbol,
        cashTradeable: d.signalKey.startsWith('NSE_EQ|'), fnoUnderlying: true,
      });
    }
  }
  if (state.focus && !map.has(state.focus.instrumentKey)) {
    map.set(state.focus.instrumentKey, {
      ...state.focus, cashTradeable: state.focus.instrumentKey.startsWith('NSE_EQ|'), fnoUnderlying: false,
    });
  }
  return [...map.values()];
}

function rollAutoDay(): void {
  const today = istDateKey(clock.now());
  if (state.autoEntries.day !== today) state.autoEntries = { day: today, count: 0 };
}

const strategyVersionFor = (strategyId: string): string | undefined =>
  registry.approved(strategyId)?.id ?? registry.list(strategyId)[0]?.id;

async function act(a: LiveAnalysis, s: LiveSetup): Promise<void> {
  const lead = s.votes.find((v) => v.strategyId === s.primaryStrategyId)?.signal;
  if (!lead) return;
  const log = (outcome: AutoLogEntry['outcome'], detail: string): void => {
    autoLog.unshift({
      at: clock.ms(), symbol: a.symbol, style: s.style, side: s.side, route: s.route ?? '-',
      quality: s.quality, strategyId: s.primaryStrategyId, outcome, detail,
    });
    if (autoLog.length > 50) autoLog.pop();
  };

  // AI review sees the lead signal with the ensemble's context.
  const ai = await aiReviewer.review(lead);
  await recordSignal(lead, ai);
  if (ai.blocked) return log('AI_BLOCKED', ai.rationale);

  const meta: EntryMeta = { strategyId: s.primaryStrategyId, strategyVersion: strategyVersionFor(s.primaryStrategyId), quality: s.quality };
  const r = s.route === 'FNO'
    ? await enterFno(a.symbol, lead, ai, meta)
    : await enterEquity(lead, s.route === 'EQ_SWING' ? 'D' : 'I', ai, meta);
  if (r.ok) {
    state.autoEntries.count++;
    log('PLACED', `${ai.verdict} · size ×${ai.sizeMultiplier}`);
  } else {
    log('REJECTED', r.reason);
  }
}

/**
 * Every TF_ANALYSIS_INTERVAL_MS: re-analyse every target with every strategy
 * on closed bars plus the forming bar, then — only if autonomous mode is on —
 * act on the single best setup that clears every user threshold. One entry per
 * cycle and a 5-minute cooldown per setup keep a persistent but rejected setup
 * from hammering the AI and the broker.
 */
async function liveCycle(): Promise<void> {
  rollAutoDay();
  const results = analyzer.analyze(
    targets(), registry.activeParams(), state.auto.strategies, state.auto,
    { mode: currentMode(), approved: (id) => registry.approved(id) !== null, entriesToday: state.autoEntries.count },
  );
  void refreshFocusAi();
  if (!state.auto.enabled || acting || !verdictNow().allowEntries) return;

  const ranked = results
    .flatMap((a) => a.setups.filter((s) => s.eligible).map((s) => ({ a, s })))
    .sort((x, y) => y.s.quality - x.s.quality);
  for (const { a, s } of ranked) {
    const key = `${a.instrumentKey}|${s.style}`;
    if ((cooldown.get(key) ?? 0) > clock.ms()) continue;
    if (trader.holds(a.instrumentKey)) continue;
    if (s.route === 'FNO' && trader.live().some((p) => p.underlyingSymbol === a.symbol)) continue;
    cooldown.set(key, clock.ms() + 5 * 60_000);
    acting = true;
    try {
      await act(a, s);
    } finally {
      acting = false;
    }
    return;
  }
}

/** Realtime AI read on the focus stock, refreshed when its setup changes (≤ every 20 s). */
const focusAi = { sig: '', at: 0, decision: null as AiDecision | null };
async function refreshFocusAi(): Promise<void> {
  if (!state.focus) return;
  const a = analyzer.results.get(state.focus.instrumentKey);
  const best = a?.setups.slice().sort((x, y) => y.quality - x.quality)[0];
  const lead = best?.votes.find((v) => v.strategyId === best.primaryStrategyId)?.signal;
  if (!best || !lead) return;
  const sig = `${best.style}|${best.side}|${best.primaryStrategyId}`;
  if (sig === focusAi.sig && clock.ms() - focusAi.at < 20_000) return;
  focusAi.sig = sig;
  focusAi.at = clock.ms();
  focusAi.decision = await aiReviewer.review(lead);
}

/** Load prior-session, today's and daily bars for an instrument. */
async function loadCandles(key: string): Promise<void> {
  const today = istDateKey(clock.now());
  const yesterday = istDateKey(new Date(clock.ms() - 86_400_000));
  const weekAgo = istDateKey(new Date(clock.ms() - 8 * 86_400_000));
  const yearAgo = istDateKey(new Date(clock.ms() - 400 * 86_400_000));
  const [hist, intra, daily] = await Promise.all([
    client.historicalCandles(key, 'minutes', 5, yesterday, weekAgo),
    client.intradayCandles(key, 'minutes', 5),
    client.historicalCandles(key, 'days', 1, today, yearAgo),
  ]);
  if (hist.ok) historyCache.set(key, hist.value);
  if (intra.ok) {
    intradayCandlesCache.set(key, intra.value);
    const last = intra.value[intra.value.length - 1];
    if (last && !lastLtp.has(key)) lastLtp.set(key, last.close);
  }
  if (daily.ok && daily.value.length > 0) dailyCandlesCache.set(key, daily.value);
}

/** Strip candle-heavy signal objects for the dashboard. */
function analysisView(a: LiveAnalysis): unknown {
  const vote = (v: LiveSetup['votes'][number]) => ({
    strategyId: v.strategyId, name: v.name, style: v.style, side: v.side, confidence: v.confidence, reasons: v.reasons,
  });
  return {
    instrumentKey: a.instrumentKey, symbol: a.symbol, ltp: a.ltp, analyzedAt: a.analyzedAt,
    votes: a.votes.map(vote),
    setups: a.setups.map(({ votes, ...rest }) => ({ ...rest, votes: votes.map(vote) })),
  };
}

// ─────────────────────────────── loops ───────────────────────────────

const sseClients = new Set<ServerResponse>();
function broadcastSse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(payload); } catch { sseClients.delete(c); }
  }
}

function startLoops(): void {
  setInterval(() => {
    void liveCycle().catch((e) => console.error('[live]', e));
  }, cfg.TF_ANALYSIS_INTERVAL_MS);

  // Exits: EOD square-off, time stops, per-trade loss. Unless a breaker that
  // also blocks exits (divergence, maintenance) is tripped — then a human acts.
  setInterval(() => {
    if (!verdictNow().allowExits) return;
    void trader.manage(ltpOf).catch((e) => console.error('[manage]', e));
  }, 1_000);

  // Live fills are pulled; the portfolio stream only makes them arrive sooner.
  setInterval(() => {
    if (broker !== paperBroker && trader.live().length > 0) void broker.sync();
  }, 3_000);

  // Option chains during market hours; the master reloads each morning.
  setInterval(() => {
    const mins = istMinutes(clock.now());
    if (mins < SESSION.OPEN - 5 || mins > SESSION.CLOSE) return;
    void (async () => {
      if (fnoDesk.needsReload()) {
        await fnoDesk.init().catch((e) => console.error('[fno] master reload', e));
        feed.subscribe(fnoDesk.feedKeys(), 'full');
      }
      await fnoDesk.refreshAll();
    })().catch((e) => console.error('[fno]', e));
  }, Math.min(cfg.TF_FNO_CHAIN_REFRESH_SEC, 60) * 1000);

  setInterval(() => {
    if (sseClients.size === 0) return;
    const snap = snapshot();
    const v = evaluate(snap, cfg.limits, clock);
    broadcastSse('telemetry', {
      mode: currentMode(),
      istTime: istHHMM(clock.now()),
      uptimeMs: clock.ms() - state.startedAt,
      ticks: state.ticks,
      feedStaleness: feed.staleness(),
      allowEntries: v.allowEntries,
      allowExits: v.allowExits,
      trips: v.trips.map((t) => t.id),
      realisedPnl: paiseToRupees(trader.realisedPnl),
      unrealisedPnl: paiseToRupees(snap.unrealisedPnlPaise),
      openPositionsCount: snap.openPositions,
      signalsCount: state.signalsCount,
      strategyMode: state.strategyMode,
      autoTrading: state.auto.enabled,
    });
  }, 1_500);
}

async function seedWarmupCandles(): Promise<void> {
  console.log('[warmup] fetching prior sessions, today and daily bars from Upstox REST...');
  const keys = [...new Set([...watchlist.keys(), ...fnoDesk.feedKeys()])];
  for (const key of keys) {
    await loadCandles(key);
    const stock = watchlist.get(key);
    const intra = intradayCandlesCache.get(key);
    if (stock && intra && intra.length > 0) {
      const last = intra[intra.length - 1]!;
      stock.ltp = last.close;
      stock.open = intra[0]!.open;
      stock.high = Math.max(...intra.map((b) => b.high));
      stock.low = Math.min(...intra.map((b) => b.low));
      stock.close = last.close;
    }
  }
  console.log(`[warmup] ${keys.length} instruments: history ${historyCache.size}, today ${intradayCandlesCache.size}, daily ${dailyCandlesCache.size}`);
}

// ─────────────────────────────── control API ───────────────────────────────

const expectedAuth = Buffer.from(`Bearer ${cfg.TF_ENGINE_TOKEN}`);
function authorized(req: IncomingMessage): boolean {
  const got = Buffer.from(req.headers.authorization ?? '');
  return got.length === expectedAuth.length && timingSafeEqual(got, expectedAuth);
}

const loginUrl = (): string =>
  `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(cfg.UPSTOX_API_KEY)}&redirect_uri=${encodeURIComponent(cfg.UPSTOX_REDIRECT_URI)}`;

function positionView(p: ManagedPosition): Record<string, unknown> {
  const ltp = ltpOf(p.instrumentKey) ?? 0;
  const pnl = p.realisedPnl ?? trader.unrealised(p, ltp);
  return {
    id: p.id,
    instrumentKey: p.instrumentKey,
    symbol: p.symbol,
    segment: p.segment,
    product: p.product,
    side: p.side,
    state: p.state,
    quantity: p.quantity,
    filledQuantity: p.filledQuantity,
    entry: paiseToRupees(p.entry),
    avgEntry: p.avgEntry !== null ? paiseToRupees(p.avgEntry) : null,
    stopLoss: paiseToRupees(p.stopLoss),
    target: paiseToRupees(p.target),
    ltp,
    pnlRupees: paiseToRupees(pnl),
    gttOrderId: p.gttOrderId,
    openedAt: p.openedAt,
    exitReason: p.exitReason,
    ...(p.contract ? { contract: p.contract } : {}),
    ...(p.underlyingSymbol ? { underlyingSymbol: p.underlyingSymbol } : {}),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // Every route moves money or reveals positions. No CORS: the dashboard calls
  // from its server, and a browser page must never reach this port directly.
  if (!authorized(req)) return json(401, { error: 'unauthorized' });

  if (url.pathname === '/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/health') {
    const v = verdictNow();
    return json(200, {
      ok: true, mode: currentMode(), istTime: istHHMM(clock.now()), ticks: state.ticks,
      feedStaleness: feed.staleness(), subscribed: feed.subscribedCount,
      allowEntries: v.allowEntries, allowExits: v.allowExits, trips: v.trips.map((t) => t.id),
    });
  }

  if (url.pathname === '/state') {
    const snap = snapshot();
    const v = evaluate(snap, cfg.limits, clock);
    const ranked = stockScanner.rankUniverse(DEFAULT_UNIVERSE, intradayCandlesCache);
    return json(200, {
      mode: currentMode(),
      baseMode: state.arm.mode,
      isArmed: currentMode() === 'LIVE',
      armedUntilMs: state.arm.armedUntilMs,
      liveCapable: broker !== paperBroker,
      autoTrading: state.auto.enabled,
      strategyMode: state.strategyMode,
      sizing: { mode: state.sizingMode, budget: state.budget, fixedQty: state.fixedQty, riskPct: state.riskPct },
      limits: {
        maxSpendPerTrade: cfg.TF_MAX_SPEND_PER_TRADE,
        maxDeployed: cfg.TF_MAX_DEPLOYED_CAPITAL,
        dailyLossLimitPct: cfg.TF_DAILY_LOSS_LIMIT_PCT,
      },
      pnl: {
        realised: paiseToRupees(trader.realisedPnl),
        unrealised: paiseToRupees(snap.unrealisedPnlPaise),
        total: paiseToRupees((trader.realisedPnl + snap.unrealisedPnlPaise) as Paise),
      },
      breakers: {
        allowEntries: v.allowEntries,
        allowExits: v.allowExits,
        trips: v.trips.map((t) => ({ id: t.id, detail: t.detail, allowExits: t.allowExits })),
      },
      telemetry: {
        istTime: istHHMM(clock.now()),
        uptimeMs: clock.ms() - state.startedAt,
        ticks: state.ticks,
        feedStaleness: feed.staleness(),
        subscribedCount: feed.subscribedCount,
        ordersCount: trader.ordersToday,
        signalsCount: state.signalsCount,
      },
      watchlist: [...watchlist.values()].map((w) => ({ ...w, bars: intradayCandlesCache.get(w.instrumentKey)?.length ?? 0 })),
      positions: [...trader.positions.values()].sort((a, b) => b.openedAt - a.openedAt).slice(0, 50).map(positionView),
      recentSignals,
      rankedStocks: ranked,
      topStock: ranked[0] ?? null,
      fno: fnoDesk.snapshot(state.fnoEnabled),
      auth: {
        hasTradingToken: tokens.trading() !== null,
        hasAnalyticsToken: tokens.data() !== null,
        tradingExpiresInMs: tokens.msUntilExpiry(),
        loginUrl: loginUrl(),
      },
    });
  }

  if (url.pathname === '/auth/status') {
    return json(200, {
      hasTradingToken: tokens.trading() !== null,
      hasAnalyticsToken: tokens.data() !== null,
      tradingExpiresInMs: tokens.msUntilExpiry(),
      loginUrl: loginUrl(),
    });
  }

  if (url.pathname === '/fno/chain' && req.method === 'GET') {
    const symbol = (url.searchParams.get('underlying') ?? '').toUpperCase();
    const s = await fnoDesk.refresh(symbol);
    if (!s) return json(404, { error: `${symbol} is not on the F&O desk` });
    const rows = s.chain && s.analytics
      ? s.chain.rows.filter((r) => Math.abs(r.strike - s.analytics!.atmStrike) <= s.analytics!.atmStrike * 0.03)
      : [];
    return json(200, { symbol, expiry: s.expiry, error: s.error, analytics: s.analytics, rows });
  }

  if (url.pathname === '/analysis/live' && req.method === 'GET') {
    const results = [...analyzer.results.values()];
    const focus = state.focus ? analyzer.results.get(state.focus.instrumentKey) ?? null : null;
    return json(200, {
      intervalMs: cfg.TF_ANALYSIS_INTERVAL_MS,
      mode: currentMode(),
      auto: state.auto,
      entriesToday: state.autoEntries.count,
      focus: state.focus ? {
        ...state.focus,
        analysis: focus ? analysisView(focus) : null,
        ai: focusAi.decision ? { ...focusAi.decision, at: focusAi.at } : null,
      } : null,
      // Best setups first; instruments with nothing to say are omitted.
      setups: results
        .flatMap((a) => (analysisView(a) as { setups: Array<{ quality: number }> }).setups)
        .sort((x, y) => y.quality - x.quality),
      analyzed: results.length,
      autoLog,
      strategies: STRATEGY_CATALOG.map((d) => ({ id: d.id, name: d.name, style: d.style, approved: registry.approved(d.id)?.id ?? null })),
    });
  }

  if (url.pathname === '/auto/config' && req.method === 'GET') return json(200, state.auto);

  if (url.pathname === '/scan/status' && req.method === 'GET') {
    return json(200, scanner.current ?? { status: 'IDLE' });
  }

  if (url.pathname === '/research/strategies' && req.method === 'GET') {
    return json(200, {
      strategies: STRATEGY_CATALOG.map((d) => ({
        id: d.id, name: d.name, style: d.style, timeframe: d.timeframe, description: d.description,
        defaults: d.defaults, bounds: d.bounds,
        versions: registry.list(d.id),
      })),
      jobs: lab.jobs,
      aiAvailable: cfg.GROQ_API_KEY !== undefined,
    });
  }

  if (url.pathname === '/memory/trades' && req.method === 'GET') {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
    const [trades, summary] = await Promise.all([memory.recent(limit), memory.summary(cfg.TF_MAX_DEPLOYED_CAPITAL)]);
    return json(200, { trades, summary });
  }

  if (req.method !== 'POST') return json(404, { error: 'not found' });

  let body: Record<string, unknown> = {};
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const str = Buffer.concat(chunks).toString('utf8');
    if (str) body = JSON.parse(str) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  switch (url.pathname) {
    case '/auth/exchange': {
      const code = String(body['code'] ?? '');
      if (!code) return json(400, { error: 'missing code' });
      const ex = await client.exchangeToken({
        code,
        clientId: cfg.UPSTOX_API_KEY,
        clientSecret: cfg.UPSTOX_API_SECRET,
        redirectUri: String(body['redirectUri'] ?? cfg.UPSTOX_REDIRECT_URI),
      });
      if (!ex.ok) return json(400, { error: ex.error.message });
      tokens.setTrading(ex.value.accessToken);
      await audit(sql, { kind: 'TOKEN_REFRESH', actor: 'engine', mode: currentMode(), payload: { success: true } });
      void startPortfolioFeed();
      return json(200, { ok: true, expiresAt: tokens.msUntilExpiry() });
    }

    case '/scanner/analyze': {
      const symbol = String(body['symbol'] ?? 'RELIANCE').toUpperCase();
      const item = DEFAULT_UNIVERSE.find((u) => u.symbol === symbol);
      if (!item) return json(404, { error: `${symbol} is not in the universe` });
      const scored = stockScanner.rankUniverse([item], intradayCandlesCache)[0];
      if (!scored?.tradeSetup) return json(404, { error: `not enough candles to analyse ${symbol}` });
      const sig = stockScanner.toSignal(scored, state.strategyMode === 'SWING' ? 'SWING' : 'INTRADAY');
      const consensus = await aiReviewer.review(sig);
      return json(200, { stock: scored, tradeSetup: scored.tradeSetup, signal: sig, consensus, votes: consensus.votes });
    }

    case '/strategy/autotrade':
      state.auto = { ...state.auto, enabled: typeof body['enabled'] === 'boolean' ? body['enabled'] : !state.auto.enabled };
      return json(200, { autoTrading: state.auto.enabled });

    case '/strategy/mode': {
      const m = body['mode'];
      if (m !== 'INTRADAY' && m !== 'SWING' && m !== 'BOTH') {
        return json(400, { error: 'invalid mode; must be INTRADAY, SWING, or BOTH' });
      }
      state.strategyMode = m;
      strategyManager.setMode(m);
      return json(200, { strategyMode: state.strategyMode });
    }

    case '/sizing': {
      const num = (k: string): number | undefined => {
        const v = body[k];
        if (v === undefined) return undefined;
        const x = Number(v);
        return Number.isFinite(x) && x > 0 ? x : Number.NaN;
      };
      const mode = body['mode'];
      if (mode !== undefined && mode !== 'FIXED_QTY' && mode !== 'FIXED_BUDGET' && mode !== 'RISK_BASED') {
        return json(400, { error: 'mode must be FIXED_QTY, FIXED_BUDGET or RISK_BASED' });
      }
      const budget = num('budget');
      const fixedQty = num('fixedQty');
      const riskPct = num('riskPct');
      if ([budget, fixedQty, riskPct].some((x) => Number.isNaN(x))) {
        return json(400, { error: 'budget, fixedQty and riskPct must be positive numbers' });
      }
      if (riskPct !== undefined && riskPct > 5) return json(400, { error: 'riskPct above 5% per trade is refused' });
      if (mode) state.sizingMode = mode;
      if (budget !== undefined) state.budget = budget;
      if (fixedQty !== undefined) state.fixedQty = Math.floor(fixedQty);
      if (riskPct !== undefined) state.riskPct = riskPct;
      return json(200, { sizingMode: state.sizingMode, budget: state.budget, fixedQty: state.fixedQty, riskPct: state.riskPct });
    }

    case '/positions/exit': {
      const r = await trader.exit(String(body['positionId'] ?? ''), 'MANUAL');
      return json(r.ok ? 200 : 409, r.ok ? { success: true, detail: r.detail } : { error: r.detail });
    }

    case '/kill': {
      const level = String(url.searchParams.get('level') ?? body['level'] ?? 'SOFT') as KillLevel;
      if (level !== 'SOFT' && level !== 'HARD' && level !== 'NUCLEAR') return json(400, { error: 'invalid level' });
      const result = await fire(level, {
        stopNewEntries: async () => {
          state.manualHalt = true;
          state.auto = { ...state.auto, enabled: false };
        },
        cancelAllOpenOrders: async () => {
          let n = 0;
          for (const p of trader.live()) {
            if (p.state === 'ENTRY_ACKED' && (await trader.exit(p.id, 'KILL_SWITCH')).ok) n++;
          }
          return n;
        },
        // Brackets are cancelled inside the broker's flatten, before it exits.
        cancelAllGtt: async () => 0,
        exitAllPositions: async () => trader.flattenAll(),
        disableSegment: async (seg) => {
          const r = await client.killSwitch(seg, 'DISABLE');
          if (!r.ok) throw new Error(r.error.message);
        },
      }, sql, currentMode(), 'user');
      // Disarm on any kill: re-entering LIVE must be a fresh, deliberate act.
      if (state.arm.mode === 'LIVE') state.arm = { mode: 'LIVE_ARMED', armedUntilMs: null, armedBy: null };
      return result.errors.length > 0
        ? json(500, { error: `kill switch ${level} partially failed: ${result.errors.join('; ')}`, result })
        : json(200, { fired: level, result });
    }

    case '/halt/reset': {
      if (trader.hasOrphan()) return json(409, { error: 'an ORPHANED position exists — resolve it at the broker first' });
      state.manualHalt = false;
      await audit(sql, { kind: 'RESUME', actor: 'user', mode: currentMode(), payload: {} });
      return json(200, { manualHalt: false });
    }

    case '/mode/arm':
    case '/mode/switch':
    case '/mode/set': {
      const requestedMode = body['mode'] ? String(body['mode']).toUpperCase() : 'LIVE';
      if (requestedMode === 'PAPER') {
        broker = paperBroker;
        trader.setBroker(broker);
        state.arm = { mode: 'PAPER', armedUntilMs: null, armedBy: null };
        await audit(sql, { kind: 'DISARM', actor: 'user', mode: currentMode(), payload: { switchedFromDashboard: true } });
        return json(200, { mode: currentMode() });
      }

      if (tokens.trading() === null) {
        return json(409, { error: 'No Upstox trading token — click "Login with Upstox" first to authenticate for live trading.' });
      }

      const pf = await preflight(sql, client, clock, { requireTrading: true });
      const failed = pf.checks.filter((c) => !c.passed && c.hard);
      if (failed.length > 0) {
        return json(409, { error: `Preflight failed: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}` });
      }

      broker = ensureUpstoxBroker();
      trader.setBroker(broker);
      state.arm = armUntilSessionEnd(clock, 'user');
      await audit(sql, { kind: 'ARM', actor: 'user', mode: currentMode(), payload: { until: state.arm.armedUntilMs } });
      void startPortfolioFeed();
      return json(200, { mode: currentMode(), armedUntilMs: state.arm.armedUntilMs });
    }

    case '/mode/disarm': {
      broker = paperBroker;
      trader.setBroker(broker);
      state.arm = { mode: 'PAPER', armedUntilMs: null, armedBy: null };
      await audit(sql, { kind: 'DISARM', actor: 'user', mode: currentMode(), payload: {} });
      return json(200, { mode: currentMode() });
    }

    case '/fno/toggle': {
      state.fnoEnabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : !state.fnoEnabled;
      if (state.fnoEnabled && fnoDesk.universe === null) {
        try {
          await fnoDesk.init(masterContracts ?? undefined);
          feed.subscribe(fnoDesk.feedKeys(), 'full');
          void fnoDesk.refreshAll();
        } catch (e) {
          state.fnoEnabled = false;
          return json(502, { error: `could not load F&O instrument master: ${e instanceof Error ? e.message : e}` });
        }
      }
      return json(200, { enabled: state.fnoEnabled });
    }

    case '/fno/analyze': {
      const symbol = String(body['symbol'] ?? '').toUpperCase();
      if (fnoDesk.universe === null) return json(409, { error: 'F&O desk not initialised — enable it first' });
      return json(200, await analyzeFno(symbol));
    }

    case '/analysis/focus': {
      const raw = body['symbol'];
      if (raw === null || raw === '') {
        state.focus = null;
        return json(200, { focus: null });
      }
      const symbol = String(raw ?? '').trim().toUpperCase();
      const desk = fnoDesk.states.get(symbol);
      const eq = equities.find((e) => e.symbol === symbol) ?? DEFAULT_UNIVERSE.find((u) => u.symbol === symbol);
      const instrumentKey = eq?.instrumentKey ?? desk?.signalKey;
      if (!instrumentKey) return json(404, { error: `${symbol} not found among NSE equities${state.fnoEnabled ? ' or F&O underlyings' : ''}` });
      state.focus = { instrumentKey, symbol };
      feed.subscribe([instrumentKey], 'full');
      await loadCandles(instrumentKey);
      focusAi.sig = '';
      const [a] = analyzer.analyze(
        [{ instrumentKey, symbol, cashTradeable: instrumentKey.startsWith('NSE_EQ|'), fnoUnderlying: false }],
        registry.activeParams(), state.auto.strategies, state.auto,
        { mode: currentMode(), approved: (id) => registry.approved(id) !== null, entriesToday: state.autoEntries.count },
      );
      void refreshFocusAi();
      return json(200, { focus: state.focus, analysis: a ? analysisView(a) : null });
    }

    case '/auto/config': {
      const merged = {
        ...state.auto,
        ...body,
        segments: { ...state.auto.segments, ...(typeof body['segments'] === 'object' && body['segments'] ? body['segments'] : {}) },
      };
      const parsed = AutoConfigSchema.safeParse(merged);
      if (!parsed.success) {
        return json(400, { error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      }
      const unknown = parsed.data.strategies.filter((id) => !STRATEGY_CATALOG.some((d) => d.id === id));
      if (unknown.length > 0) return json(400, { error: `unknown strategies: ${unknown.join(', ')}` });
      if (parsed.data.segments.fno && !state.fnoEnabled) {
        return json(409, { error: 'enable the F&O desk before allowing autonomous F&O entries' });
      }
      state.auto = parsed.data;
      await audit(sql, { kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(), payload: { auto: state.auto as never } });
      return json(200, state.auto);
    }

    case '/scan': {
      const r = scanner.start((body['filters'] ?? body) as ScanFilters);
      return r.ok ? json(202, r.job) : json(409, { error: r.error });
    }

    case '/research/validate': {
      try {
        const days = body['days'] !== undefined ? Number(body['days']) : undefined;
        return json(202, lab.validate(String(body['versionId'] ?? ''), days && days > 0 ? days : undefined));
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    case '/research/propose': {
      try {
        return json(202, lab.propose(String(body['strategyId'] ?? '')));
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    case '/research/approve': {
      try {
        // Approval is the one human gate in the research loop; it is audited.
        const v = await registry.approve(String(body['versionId'] ?? ''), 'user');
        await audit(sql, { kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(), payload: { approved: v.id } });
        return json(200, v);
      } catch (e) {
        return json(409, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    case '/research/retire': {
      try {
        return json(200, await registry.retire(String(body['versionId'] ?? '')));
      } catch (e) {
        return json(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }

    case '/hooks/order':
    case '/hooks/token':
      // Untrusted hints: they only prompt a pull of authoritative state.
      void audit(sql, { kind: 'WEBHOOK_HINT', actor: 'webhook', mode: currentMode(), payload: { path: url.pathname } });
      void broker.sync();
      return json(200, { accepted: true, action: 'resynced' });
  }

  return json(404, { error: 'not found' });
});

async function main(): Promise<void> {
  console.log(`TradeForger engine booting — TF_MODE ${cfg.TF_MODE}, strategy ${cfg.TF_AUTO_TRADING_MODE}, F&O ${cfg.TF_FNO_ENABLED ? cfg.TF_FNO_INSTRUMENT : 'off'}, IST ${istHHMM(clock.now())}`);
  await audit(sql, {
    kind: 'ENGINE_BOOT', actor: 'engine', mode: cfg.TF_MODE,
    payload: { version: '0.3.0', sizingMode: cfg.TF_SIZING_MODE, strategyMode: cfg.TF_AUTO_TRADING_MODE, fno: cfg.TF_FNO_ENABLED },
  });

  if (cfg.TF_MODE === 'SANDBOX') {
    console.warn('SANDBOX has no market data or GTT support (docs/00-PLAN.md §0.3) — running the PAPER broker');
  }

  const pf = await preflight(sql, client, clock, { requireTrading: wantsLiveBroker });
  for (const c of pf.checks) console.log(`  ${c.passed ? '✓' : c.hard ? '✗' : '·'} ${c.name.padEnd(20)} ${c.detail}`);

  if (wantsLiveBroker && pf.passed) {
    broker = new UpstoxBroker({
      client,
      clock,
      modeGate: currentMode,
      onDryRun: (kind, payload) => {
        console.log(`[DRY RUN ${currentMode()}] ${kind}`, JSON.stringify(payload));
        void audit(sql, { kind: 'ORDER_REQUEST', actor: 'engine', mode: currentMode(), payload: { dryRun: true, kind, payload: payload as never } });
      },
    });
  } else if (wantsLiveBroker) {
    console.warn('Preflight failed — running the PAPER broker; no order will reach Upstox this session');
    state.arm = { mode: 'PAPER', armedUntilMs: null, armedBy: null };
  }

  trader = new Trader({
    clock,
    broker,
    machine: positionMachine,
    perTradeLossPaise: () => pctOf(rupeesToPaise(cfg.TF_MAX_DEPLOYED_CAPITAL), cfg.limits.perTradeLossPct),
    onClosed: onPositionClosed,
  });

  // One download serves the scan universe, the focus lookup and the F&O desk.
  try {
    const rows = await fetchMasterRows();
    equities = parseEquities(rows);
    masterContracts = parseMaster(rows);
    console.log(`[master] ${equities.length} NSE equities, ${masterContracts.length} F&O contracts`);
  } catch (e) {
    console.error('[master] instrument master failed to load — scanner and focus lookup unavailable:', e instanceof Error ? e.message : e);
  }
  try {
    await registry.load();
    console.log(`[registry] ${registry.list().length} strategy versions; approved: ${STRATEGY_CATALOG.filter((d) => registry.approved(d.id)).map((d) => d.id).join(', ') || 'none'}`);
  } catch (e) {
    console.error('[registry] failed to load (run npm run migrate) — LIVE autonomous entries will find no approved strategy:', e instanceof Error ? e.message : e);
  }

  if (state.fnoEnabled) {
    try {
      await fnoDesk.init(masterContracts ?? undefined);
      console.log(`[fno] master loaded — ${fnoDesk.universe!.size} contracts; desk: ${[...fnoDesk.states.values()].map((s) => `${s.symbol}${s.error ? ` (${s.error})` : ` ${s.expiry}`}`).join(', ')}`);
      await fnoDesk.refreshAll();
    } catch (e) {
      state.fnoEnabled = false;
      console.error('[fno] disabled — instrument master failed to load:', e instanceof Error ? e.message : e);
    }
  }

  await seedWarmupCandles();
  startLoops();

  try {
    await feed.connect();
  } catch (err) {
    console.error('[feed connect failed]', err);
  }
  void startPortfolioFeed();

  server.listen(cfg.TF_ENGINE_PORT, cfg.TF_ENGINE_HOST, () => {
    console.log(`✓ Control API on http://${cfg.TF_ENGINE_HOST}:${cfg.TF_ENGINE_PORT} (bearer auth required)`);
    console.log(`✓ Broker: ${broker === paperBroker ? 'PAPER' : 'UPSTOX (orders only while armed)'} · mode ${currentMode()}`);
    console.log(`✓ AI: local ensemble${cfg.GROQ_API_KEY ? ` + ${cfg.GROQ_MODEL}` : ''}`);
  });
}

let shuttingDown = false;
const shutdown = async (sig: string): Promise<void> => {
  // A supervisor may deliver several signals; one shutdown, one audit row.
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${sig} — shutting down`);
  await audit(sql, { kind: 'ENGINE_SHUTDOWN', actor: 'engine', mode: currentMode(), payload: { sig, openPositions: trader?.live().length ?? 0 } });
  feed.close();
  portfolioFeed.close();
  server.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (e: unknown) => {
  console.error('Engine startup failure:', e);
  await closeDb();
  process.exit(1);
});

