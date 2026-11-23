import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import {
  SystemClock, istHHMM, istDateKey, istMinutes, SESSION, rupeesToPaise, paiseToRupees,
  type Paise, type Candle, type Tick, type Side, type Signal, type SizingMode, type Mode, type Product, pctOf, computeIndianCharges,
} from '@tradeforger/core';
import { db, audit, closeDb, runMigrations } from '@tradeforger/db';
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
import { STRATEGY_CATALOG, pickUniverse, type ScanFilters, type QuoteLite } from '@tradeforger/strategy';
import { loadConfig, LIVE_CONFIRMATION, type EngineConfig } from './config.ts';
import { preflight } from './preflight.ts';
import { Trader, isOperatorExit, type ManagedPosition } from './trader.ts';
import { PositionStore, EngineStateStore } from './journal.ts';
import { planRecovery, type UpstoxView } from './recovery.ts';
import { StrategyRegistry } from './registry.ts';
import { TradeMemory } from './memory.ts';
import {
  LiveAnalyzer, AutoConfigSchema, DEFAULT_AUTO, mergeCandles, segmentsForMode, modeForSegments, sideAllowed,
  type AutoConfig, type DecisionContext, type StrategyRecord, type LiveAnalysis, type LiveSetup, type Target,
} from './live.ts';
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

const TOKEN_FILE_PATH = existsSync('/app/data') ? '/app/data/trading_token.json' : resolve(process.cwd(), 'data/trading_token.json');

function loadPersistedTradingToken(): string | null {
  try {
    if (!existsSync(TOKEN_FILE_PATH)) return null;
    const raw = readFileSync(TOKEN_FILE_PATH, 'utf8');
    const data = JSON.parse(raw) as { token?: string };
    if (data.token) {
      const exp = jwtExpiryMs(data.token);
      if (exp !== null && exp > clock.ms()) return data.token;
    }
  } catch (e) {
    console.warn('[token] failed to read persisted token:', e);
  }
  return null;
}

function persistTradingToken(token: string): void {
  try {
    mkdirSync(dirname(TOKEN_FILE_PATH), { recursive: true });
    writeFileSync(TOKEN_FILE_PATH, JSON.stringify({ token, savedAt: clock.ms() }), 'utf8');
  } catch (e) {
    console.warn('[token] failed to persist token:', e);
  }
}

// Check configured token, fallback to persisted token file
if (cfg.UPSTOX_ACCESS_TOKEN) {
  const exp = jwtExpiryMs(cfg.UPSTOX_ACCESS_TOKEN);
  if (exp !== null && exp > clock.ms()) {
    tokens.setTrading(cfg.UPSTOX_ACCESS_TOKEN);
    persistTradingToken(cfg.UPSTOX_ACCESS_TOKEN);
  } else {
    console.warn('UPSTOX_ACCESS_TOKEN is expired or unreadable — checking persisted session...');
  }
}
if (!tokens.trading()) {
  const saved = loadPersistedTradingToken();
  if (saved) {
    tokens.setTrading(saved);
    console.log('✓ Restored active Upstox trading session from storage');
  }
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
  geminiConfig: cfg.GEMINI_API_KEY
    ? { apiKey: cfg.GEMINI_API_KEY, model: cfg.GEMINI_MODEL, baseUrl: cfg.GEMINI_BASE_URL, timeoutMs: 4000 }
    : null,
  grokConfig: cfg.XAI_API_KEY
    ? { apiKey: cfg.XAI_API_KEY, model: cfg.GROK_MODEL, baseUrl: cfg.GROK_BASE_URL, timeoutMs: 3000 }
    : null,
  groqConfig: cfg.GROQ_API_KEY
    ? { apiKey: cfg.GROQ_API_KEY, model: cfg.GROQ_MODEL, baseUrl: cfg.GROQ_BASE_URL, timeoutMs: 1500 }
    : null,
});

const activeAiEngines = [
  '3 Quantitative Models (Geometry, Pattern, ML Expectancy)',
  cfg.GEMINI_API_KEY ? `Google Gemini (${cfg.GEMINI_MODEL})` : null,
  cfg.XAI_API_KEY ? `xAI Grok (${cfg.GROK_MODEL})` : null,
  cfg.GROQ_API_KEY ? `Groq Cloud (${cfg.GROQ_MODEL})` : null,
].filter(Boolean);
console.log(`✓ AI Consensus Engine active: ${activeAiEngines.join(' + ')}`);

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
    segments: segmentsForMode(cfg.TF_AUTO_TRADING_MODE, DEFAULT_AUTO.segments),
  } as AutoConfig,
  autoEntries: { day: '', count: 0 },
  /** The single stock the dashboard is analysing in real time. */
  focus: null as { instrumentKey: string; symbol: string } | null,
  /** Resolved instrument for SINGLE_STOCK scope; analysed whatever the focus is. */
  singleTarget: null as { instrumentKey: string; symbol: string } | null,
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
const addWatch = (s: { instrumentKey: string; symbol: string; name: string }): void => {
  if (watchlist.has(s.instrumentKey)) return;
  watchlist.set(s.instrumentKey, {
    ...s, ltp: 0, changePct: 0, open: 0, high: 0, low: 0, close: 0, volume: 0, lastUpdated: clock.ms(),
  });
};
for (const s of DEFAULT_UNIVERSE) addWatch(s);

/**
 * Stocks added to the live watchlist from scan results, on top of the default
 * universe. Everything on the watchlist is streamed, analysed every cycle and
 * eligible for autonomous entries — "all scanned" means exactly this set.
 */
const watchlistExtra = new Map<string, { instrumentKey: string; symbol: string; name: string }>();
/** Feed and REST budget: each stock costs a stream slot and three candle calls. */
const MAX_WATCHLIST_EXTRA = 40;

/**
 * Stocks the engine picked itself from the whole market (`refreshAutoUniverse`),
 * on top of the default universe and the stocks added by hand. Replaced on
 * every refresh; analysed and traded exactly like the rest of the watchlist.
 */
const autoPicks = new Map<string, { instrumentKey: string; symbol: string; name: string }>();
const autoUniverse = { refreshedAt: null as number | null, attemptedAt: 0, scanned: 0, error: null as string | null, busy: false };
const AUTO_UNIVERSE_REFRESH_MS = 5 * 60_000;

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

const positionStore = new PositionStore(sql, () => ({ mode: currentMode(), sizingMode: state.sizingMode }));
const settingsStore = new EngineStateStore(sql);

/**
 * States that precede an order. If the journal cannot record one, the order is
 * not sent — an order the engine could not recover after a crash must not exist.
 * Every other transition records a fact (a fill, an exit) or reduces risk; a
 * journal failure there must never stop it, so it is queued and retried.
 */
const JOURNAL_REQUIRED = new Set(['AI_REVIEWED', 'RISK_APPROVED', 'ENTRY_SENT']);
const journalBacklog = new Set<string>();

const positionMachine = new PositionMachine(async (p, from, to) => {
  try {
    await positionStore.save(p as ManagedPosition, to);
    journalBacklog.delete(p.id);
  } catch (e) {
    if (JOURNAL_REQUIRED.has(to)) throw e;
    journalBacklog.add(p.id);
    console.error(`[journal] ${p.symbol} ${from}→${to} not persisted (will retry):`, e instanceof Error ? e.message : e);
  }
  await audit(sql, {
    kind: 'STATE_TRANSITION',
    actor: 'engine',
    mode: currentMode(),
    positionId: p.id,
    payload: { symbol: p.symbol, from, to, qty: p.quantity, filled: p.filledQuantity },
  });
});

async function flushJournal(): Promise<void> {
  for (const id of [...journalBacklog]) {
    const p = trader.positions.get(id);
    if (!p) { journalBacklog.delete(id); continue; }
    try {
      await positionStore.save(p, p.state);
      journalBacklog.delete(id);
    } catch {
      return; // database still down; next tick retries
    }
  }
}

/** Dashboard choices that survive a restart. Autonomy itself always boots from TF_AUTO_ENABLED. */
interface PersistedSettings {
  auto: Omit<AutoConfig, 'enabled'>;
  strategyMode: AutoTradingStrategyMode;
  sizing: { mode: SizingMode; budget: number; fixedQty: number; riskPct: number };
  watchlistExtra: Array<{ instrumentKey: string; symbol: string; name: string }>;
  /** F&O desk loaded (chains, master). Autonomous F&O entries also need auto.segments.fno. */
  fnoEnabled?: boolean;
}

function persistSettings(): void {
  const { enabled: _enabled, ...auto } = state.auto;
  const s: PersistedSettings = {
    auto,
    strategyMode: state.strategyMode,
    sizing: { mode: state.sizingMode, budget: state.budget, fixedQty: state.fixedQty, riskPct: state.riskPct },
    watchlistExtra: [...watchlistExtra.values()],
    fnoEnabled: state.fnoEnabled,
  };
  void settingsStore.set('settings', s).catch((e) => console.error('[settings] not persisted:', e instanceof Error ? e.message : e));
}

const paperBroker = new PaperBroker(clock);
let broker: BrokerPort = paperBroker;
let upstoxBroker: UpstoxBroker | null = null;
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

function applyTick(t: Tick): void {
  state.ticks++;
  state.lastTickMs = clock.ms();
  feed.recordTick(clock.ms());
  lastLtp.set(t.instrumentKey, t.ltp);
  // Always: paper positions keep settling while the dashboard is in LIVE.
  paperBroker.onTick(t);

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
}

feed.on('tick', applyTick);

/** Why the market-data WebSocket is not delivering, for the dashboard. Null while connected. */
let feedIssue: string | null = null;
feed.on('error', (e) => {
  if (/\b403\b/.test(e.message)) {
    // Upstox answers 403 with an empty body when the account's WebSocket slots
    // are taken; say so once instead of logging the same line every reconnect.
    if (!feedIssue?.startsWith('Upstox refused')) {
      console.error('[feed] Upstox refused the market-data WebSocket (HTTP 403, empty body). Upstox allows 2 WebSocket '
        + 'connections per account across every app and device; another session using this account or API key holds '
        + 'them, or Upstox is refusing this key — check other running engines/scripts, then ask Upstox support. '
        + 'Prices fall back to REST polling every 2 s meanwhile.');
    }
    feedIssue = 'Upstox refused the WebSocket (HTTP 403) — another session on this Upstox account holds both connection slots, or Upstox is refusing this API key';
    return;
  }
  feedIssue = e.message;
  console.error('[feed]', e.message);
});
/** Where prices are actually coming from right now. */
const priceSource = (): 'WEBSOCKET' | 'REST_POLL' | 'NONE' =>
  feed.isConnected ? 'WEBSOCKET'
    : state.lastTickMs !== null && clock.ms() - state.lastTickMs < 10_000 ? 'REST_POLL' : 'NONE';
feed.on('open', () => {
  feedIssue = null;
  const keys = [...new Set([
    ...watchlist.keys(), ...fnoDesk.feedKeys(), ...trader.live().map((p) => p.instrumentKey),
    ...(state.focus ? [state.focus.instrumentKey] : []),
    ...(state.singleTarget ? [state.singleTarget.instrumentKey] : []),
  ])];
  const { accepted, rejected } = feed.subscribe(keys, 'full');
  console.log(`[feed] connected — subscribed ${accepted.length} instruments, rejected ${rejected.length}`);
});
let lastFeedCloseLog = 0;
feed.on('close', (c, r) => {
  const now = clock.ms();
  if (feedIssue && now - lastFeedCloseLog < 30_000) return;
  lastFeedCloseLog = now;
  console.warn(`[feed] closed ${c} ${r}`);
});

// The second (and last) WebSocket the standard tier allows. Live only.
const portfolioFeed = new PortfolioFeed(async () => {
  const r = await client.portfolioFeedUrl();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, clock);
portfolioFeed.on('order', () => void upstoxBroker?.sync());
portfolioFeed.on('gtt', () => void upstoxBroker?.sync());
portfolioFeed.on('error', (e: Error) => console.error('[portfolio feed]', e.message));
let portfolioFeedStarted = false;

async function startPortfolioFeed(): Promise<void> {
  if (portfolioFeedStarted || upstoxBroker === null || tokens.trading() === null) return;
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
  paperBroker.onTick({ instrumentKey, ltp: q.last_price, ts: clock.ms() });
  return q.last_price;
}

function onPositionClosed(p: ManagedPosition): void {
  // The strategy's record must include this trade before its next entry is judged.
  void memory.record(p, currentMode()).then(() => refreshStrategyRecords()).catch(() => undefined);
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
type EntryResult = { ok: true; detail?: string } | { ok: false; reason: string };

/**
 * Cash-segment entry for a confirmed setup: sizing, the AI size multiplier,
 * a last breaker check, then the Trader. Intraday uses product I, swing D.
 */
async function enterEquity(signal: Signal, product: Product, ai: AiDecision, meta: EntryMeta): Promise<EntryResult> {
  const key = signal.instrumentKey;
  // Last line behind decide(): a delivery SELL would sell demat holdings, and
  // the direction filter is the user's, whatever path reached here.
  if (signal.side === 'SELL' && product === 'D') return { ok: false, reason: 'swing SELL refused — it would sell delivery holdings' };
  if (!sideAllowed(signal.side, state.auto.tradeSide)) return { ok: false, reason: `direction filter is ${state.auto.tradeSide} — ${signal.side} refused` };
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

  // Edge after costs. The strategy's R:R ignores brokerage, STT, exchange fees,
  // GST and stamp duty; on a tight intraday stop those are a large slice of the
  // risk, and a trade that clears the floor only before costs has no edge.
  const [entryRs, stopRs, targetRs] = [signal.entry, signal.stopLoss, signal.target].map(paiseToRupees) as [number, number, number];
  const long = signal.side === 'BUY';
  const style = signal.style === 'SWING' ? 'SWING' : 'INTRADAY';
  const roundTrip = (exitRs: number): number => computeIndianCharges({
    style, qty, buyPrice: long ? entryRs : exitRs, sellPrice: long ? exitRs : entryRs,
  }).totalCharges;
  const costAtTarget = roundTrip(targetRs);
  const netReward = Math.abs(targetRs - entryRs) * qty - costAtTarget;
  const netRisk = Math.abs(entryRs - stopRs) * qty + roundTrip(stopRs);
  const netRR = netRisk > 0 ? netReward / netRisk : 0;
  if (netRR < state.auto.minNetRewardRisk) {
    return { ok: false, reason: `R:R after ₹${costAtTarget.toFixed(2)} round-trip charges is ${netRR.toFixed(2)} (min ${state.auto.minNetRewardRisk}) — charges eat the edge at ${qty} shares` };
  }

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
    // Trail at the initial risk distance: the stop starts where the strategy put
    // it and only ever moves to lock in gains (held at the exchange in the GTT).
    trailingGap: state.auto.trailStop ? (Math.abs(signal.entry - signal.stopLoss) as Paise) : null,
    costPaise: (signal.entry * qty) as Paise,
    timeStopMin: null,
    strategyId: meta.strategyId,
    ...(meta.strategyVersion ? { strategyVersion: meta.strategyVersion } : {}),
    quality: meta.quality,
  });
  return r.ok
    ? { ok: true, detail: `${qty} × ₹${entryRs.toFixed(2)} · net R:R ${netRR.toFixed(2)} after ~₹${costAtTarget.toFixed(2)} charges${state.auto.trailStop ? ' · trailing stop' : ''}` }
    : { ok: false, reason: r.reason };
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
  // The filter is on the view: a put is a bearish (SELL) view even though the order buys.
  if (!sideAllowed(signal.side, state.auto.tradeSide)) {
    const reason = `direction filter is ${state.auto.tradeSide} — ${signal.side === 'BUY' ? 'bullish' : 'bearish'} setup refused`;
    fnoDesk.record(fnoDesk.view(symbol, signal, plan, 'REJECTED', reason));
    return { ok: false, reason };
  }
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
  const bars = liveBars([s.signalKey]);
  const candles = bars.get(s.signalKey) ?? [];
  const scored = stockScanner.rankUniverse([{ instrumentKey: s.signalKey, symbol, name: symbol }], bars)[0];
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

/**
 * What every view ranks on: prior sessions for warmup, today's closed bars and
 * the forming bar. Today's cache alone is empty until ~10:30 and a bar behind.
 */
function liveBars(keys: Iterable<string>): Map<string, Candle[]> {
  const out = new Map<string, Candle[]>();
  for (const k of keys) {
    const partial = candleSource.partial(k);
    out.set(k, partial ? mergeCandles(candleSource.intraday(k), [partial]) : candleSource.intraday(k));
  }
  return out;
}

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
  const single = state.auto.targetMode === 'SINGLE_STOCK' ? state.singleTarget : null;
  if (single && !map.has(single.instrumentKey)) {
    map.set(single.instrumentKey, {
      ...single, cashTradeable: single.instrumentKey.startsWith('NSE_EQ|'), fnoUnderlying: false,
    });
  }
  return [...map.values()];
}

/** An NSE equity by symbol: the default universe first, then the instrument master. */
function resolveEquity(symbol: string): { instrumentKey: string; symbol: string } | null {
  const hit = DEFAULT_UNIVERSE.find((u) => u.symbol === symbol) ?? equities.find((e) => e.symbol === symbol);
  return hit ? { instrumentKey: hit.instrumentKey, symbol: hit.symbol } : null;
}

/**
 * Point SINGLE_STOCK scope at a symbol: resolve it, stream it and load its bars.
 * An unknown symbol is refused — accepting it would leave autonomous mode
 * "locked" to a stock that is never analysed, so it would silently never trade.
 */
async function setSingleTarget(symbol: string): Promise<string | null> {
  const eq = resolveEquity(symbol);
  if (!eq) return `${symbol} not found among NSE equities${equities.length === 0 ? ' (instrument master not loaded)' : ''}`;
  state.singleTarget = eq;
  state.focus = eq;
  focusAi.sig = '';
  feed.subscribe([eq.instrumentKey], 'full');
  await loadCandles(eq.instrumentKey);
  return null;
}

function setStrategyMode(m: AutoTradingStrategyMode): void {
  state.strategyMode = m;
  strategyManager.setMode(m);
  state.auto = { ...state.auto, segments: segmentsForMode(m, state.auto.segments) };
}

/**
 * Disarm is never refused. New entries go to the paper broker at once; open
 * Upstox positions stay on Upstox, where their brackets live, and are still
 * managed — the Upstox broker never gates an exit on the mode.
 */
async function disarm(payload: Record<string, unknown>): Promise<{ mode: Mode; detail?: string }> {
  state.arm = { mode: 'PAPER', armedUntilMs: null, armedBy: null };
  trader.setBroker('PAPER', paperBroker);
  const stillLive = trader.live().filter((p) => p.broker === 'UPSTOX').length;
  await audit(sql, { kind: 'DISARM', actor: 'user', mode: currentMode(), payload: { ...payload, upstoxPositionsOpen: stillLive } as never });
  return stillLive > 0
    ? { mode: currentMode(), detail: `${stillLive} real position(s) remain on Upstox, protected by their brackets and still managed` }
    : { mode: currentMode() };
}

/**
 * Load or unload the F&O desk (instrument master, option chains, feed keys).
 * Turning it off also stops autonomous F&O entries: without the desk the
 * engine cannot price or choose a contract.
 */
async function setFnoDesk(on: boolean): Promise<string | null> {
  if (on && fnoDesk.universe === null) {
    try {
      await fnoDesk.init(masterContracts ?? undefined);
      feed.subscribe(fnoDesk.feedKeys(), 'full');
      void fnoDesk.refreshAll();
    } catch (e) {
      state.fnoEnabled = false;
      return `could not load F&O instrument master: ${e instanceof Error ? e.message : e}`;
    }
  }
  state.fnoEnabled = on;
  if (!on) state.auto = { ...state.auto, segments: { ...state.auto.segments, fno: false } };
  return null;
}

/** Put a stock on the live watchlist: streamed, analysed every cycle, eligible for autonomous entries. */
async function addToWatchlist(symbol: string): Promise<string | null> {
  const eq = resolveEquity(symbol);
  if (!eq) return `${symbol} not found among NSE equities${equities.length === 0 ? ' (instrument master not loaded)' : ''}`;
  if (watchlistExtra.has(eq.instrumentKey) || DEFAULT_UNIVERSE.some((u) => u.instrumentKey === eq.instrumentKey)) return null;
  if (watchlistExtra.size >= MAX_WATCHLIST_EXTRA) return `live watchlist is full (${MAX_WATCHLIST_EXTRA} added stocks) — remove one first`;
  const item = { ...eq, name: equities.find((e) => e.instrumentKey === eq.instrumentKey)?.name ?? eq.symbol };
  watchlistExtra.set(eq.instrumentKey, item);
  // An auto pick is already streamed and loaded; adding it by hand only keeps it.
  if (watchlist.has(eq.instrumentKey)) return null;
  addWatch(item);
  feed.subscribe([eq.instrumentKey], 'full');
  await loadCandles(eq.instrumentKey);
  return null;
}

function removeFromWatchlist(symbol: string): string | null {
  const item = [...watchlistExtra.values()].find((w) => w.symbol === symbol);
  if (!item) return DEFAULT_UNIVERSE.some((u) => u.symbol === symbol) ? `${symbol} is in the default universe` : `${symbol} is not on the watchlist`;
  watchlistExtra.delete(item.instrumentKey);
  watchlist.delete(item.instrumentKey);
  analyzer.results.delete(item.instrumentKey);
  // Keep streaming what something else still needs a price for.
  const needed = trader.holds(item.instrumentKey)
    || state.focus?.instrumentKey === item.instrumentKey || state.singleTarget?.instrumentKey === item.instrumentKey;
  if (!needed) feed.unsubscribe([item.instrumentKey]);
  return null;
}

const autoUniverseView = () => ({
  enabled: state.auto.autoUniverse,
  picks: [...autoPicks.values()].map((p) => p.symbol),
  refreshedAt: autoUniverse.refreshedAt,
  scanned: autoUniverse.scanned,
  error: autoUniverse.error,
});

/** Stop analysing an auto pick, unless the default universe or the user also lists it. */
function dropAutoPick(key: string): void {
  autoPicks.delete(key);
  if (watchlistExtra.has(key) || DEFAULT_UNIVERSE.some((u) => u.instrumentKey === key)) return;
  watchlist.delete(key);
  analyzer.results.delete(key);
  const needed = trader.holds(key) || state.focus?.instrumentKey === key || state.singleTarget?.instrumentKey === key;
  if (!needed) feed.unsubscribe([key]);
}

/**
 * Re-pick the day's movers from every NSE EQ-series stock: one batch-quote
 * pass (~5 calls), `pickUniverse`, then candles only for stocks new to the
 * watchlist. A current pick still in the top 2N keeps its place, so the list
 * does not churn — each churn resets a setup's stability clock and costs
 * three candle calls.
 */
async function refreshAutoUniverse(): Promise<void> {
  if (!state.auto.autoUniverse) {
    for (const key of [...autoPicks.keys()]) dropAutoPick(key);
    return;
  }
  if (autoUniverse.busy) return;
  if (equities.length === 0) {
    autoUniverse.error = 'instrument master not loaded';
    return;
  }
  autoUniverse.busy = true;
  autoUniverse.attemptedAt = clock.ms();
  // Company shares only. ETFs (INF… fund-unit ISINs) share the EQ series, but a
  // gold or index ETF tracks something else entirely, is mostly not allowed
  // intraday at Upstox, and its steady turnover crowds the movers list.
  const stocks = equities.filter((e) => (e.isin ?? e.instrumentKey.split('|')[1] ?? '').startsWith('INE'));
  try {
    const quotes: QuoteLite[] = [];
    for (let i = 0; i < stocks.length; i += QUOTE_BATCH) {
      const batch = stocks.slice(i, i + QUOTE_BATCH);
      const byKey = new Map(batch.map((e) => [e.instrumentKey, e]));
      const r = await client.quotes(batch.map((e) => e.instrumentKey));
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
    }

    // A stock whose one share the per-trade ceiling (or the budget) cannot buy is not a candidate.
    const affordable = Math.min(cfg.TF_MAX_SPEND_PER_TRADE, state.sizingMode === 'FIXED_BUDGET' ? state.budget : Infinity);
    const size = state.auto.autoUniverseSize;
    const ranked = pickUniverse(quotes, {
      size: size * 2,
      minTurnoverCr: state.auto.autoUniverseMinTurnoverCr,
      minPrice: state.auto.minPrice,
      maxPrice: state.auto.maxPrice > 0 && state.auto.maxPrice < 500000 ? Math.min(state.auto.maxPrice, affordable) : affordable,
      side: state.auto.tradeSide,
    });
    const stay = ranked.filter((q) => autoPicks.has(q.instrumentKey)).slice(0, size);
    const picks = [...stay, ...ranked.filter((q) => !autoPicks.has(q.instrumentKey)).slice(0, size - stay.length)];

    const next = new Set(picks.map((q) => q.instrumentKey));
    for (const key of [...autoPicks.keys()]) if (!next.has(key)) dropAutoPick(key);
    const fresh: string[] = [];
    for (const q of picks) {
      const item = { instrumentKey: q.instrumentKey, symbol: q.symbol, name: q.name };
      autoPicks.set(q.instrumentKey, item);
      if (watchlist.has(q.instrumentKey)) continue;
      addWatch(item);
      Object.assign(watchlist.get(q.instrumentKey)!, {
        ltp: q.ltp, open: q.open, high: q.high, low: q.low, close: q.prevClose, volume: q.volume,
        changePct: q.prevClose > 0 ? ((q.ltp - q.prevClose) / q.prevClose) * 100 : 0,
      });
      lastLtp.set(q.instrumentKey, q.ltp);
      fresh.push(q.instrumentKey);
    }
    if (fresh.length > 0) feed.subscribe(fresh, 'full');
    for (const key of fresh) await loadCandles(key);

    Object.assign(autoUniverse, { refreshedAt: clock.ms(), scanned: quotes.length, error: null });
    console.log(`[universe] ${picks.length} picks from ${quotes.length} quotes (+${fresh.length} new): ${picks.map((q) => q.symbol).join(', ')}`);
  } catch (e) {
    autoUniverse.error = e instanceof Error ? e.message : String(e);
    console.error('[universe]', autoUniverse.error);
  } finally {
    autoUniverse.busy = false;
  }
}

/** Each strategy's own recent record in the current mode (LIVE vs simulated), refreshed every minute. */
let strategyRecords = new Map<string, StrategyRecord>();
/** Rolling window per strategy: recent behaviour matters more than last quarter's. */
const RECORD_WINDOW = 50;

async function refreshStrategyRecords(): Promise<void> {
  const live = currentMode() === 'LIVE';
  const trades = (await memory.recent(1000))
    .filter((t) => (t.mode === 'LIVE') === live && t.strategyId && t.rMultiple !== null && !isOperatorExit(t.exitReason));
  const by = new Map<string, number[]>();
  for (const t of trades) {
    const list = by.get(t.strategyId!) ?? [];
    if (list.length < RECORD_WINDOW) list.push(t.rMultiple!); // newest first
    by.set(t.strategyId!, list);
  }
  strategyRecords = new Map([...by].map(([id, rs]) => [id, { trades: rs.length, expectancyR: rs.reduce((a, r) => a + r, 0) / rs.length }]));
}

/** Everything `decide()` needs to know about the account right now. */
function decisionContext(): DecisionContext {
  const open = trader.live();
  const byStrategy: Record<string, number> = {};
  for (const p of open) if (p.strategyId) byStrategy[p.strategyId] = (byStrategy[p.strategyId] ?? 0) + 1;
  return {
    mode: currentMode(),
    approved: (id) => registry.approved(id) !== null,
    entriesToday: state.autoEntries.count,
    open: {
      total: open.length,
      byStrategy,
      bySide: { BUY: open.filter((p) => p.side === 'BUY').length, SELL: open.filter((p) => p.side === 'SELL').length },
    },
    record: (id) => strategyRecords.get(id) ?? null,
    verdict: (id) => registry.activeVerdict(id),
  };
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
    log('PLACED', `${ai.verdict} · size ×${ai.sizeMultiplier}${r.detail ? ` · ${r.detail}` : ''}`);
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
    decisionContext(),
  );
  void refreshFocusAi();
  if (!state.auto.enabled || acting || !verdictNow().allowEntries) return;

  let ranked = results
    .flatMap((a) => a.setups.filter((s) => s.eligible).map((s) => ({ a, s })))
    .sort((x, y) => y.s.quality - x.s.quality);

  if (state.auto.targetMode === 'SINGLE_STOCK' && state.auto.targetSymbol) {
    const sym = state.auto.targetSymbol.toUpperCase();
    ranked = ranked.filter(({ a }) => a.symbol.toUpperCase() === sym);
  }

  if (state.auto.minPrice > 0 || (state.auto.maxPrice > 0 && state.auto.maxPrice < 500000)) {
    const minP = state.auto.minPrice ?? 0;
    const maxP = (state.auto.maxPrice ?? 0) > 0 ? state.auto.maxPrice : Number.MAX_SAFE_INTEGER;
    ranked = ranked.filter(({ s }) => s.entry >= minP && s.entry <= maxP);
  }

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

let pollingInProgress = false;
/** Upstox's full-quote endpoint takes up to 500 instruments per call. */
const QUOTE_BATCH = 500;

/**
 * REST fallback while the WebSocket is not ticking: one full-quote poll of
 * everything the engine prices — the watchlist, focus and single-stock target,
 * F&O underlyings and every open position.
 */
async function pollQuotesOnce(): Promise<void> {
  if (pollingInProgress) return;
  const keys = [...new Set([
    ...watchlist.keys(),
    ...(state.fnoEnabled ? fnoDesk.feedKeys() : []),
    ...(state.focus?.instrumentKey ? [state.focus.instrumentKey] : []),
    ...(state.singleTarget?.instrumentKey ? [state.singleTarget.instrumentKey] : []),
    ...trader.live().map((p) => p.instrumentKey),
  ])];
  if (keys.length === 0) return;

  pollingInProgress = true;
  try {
    for (let i = 0; i < keys.length; i += QUOTE_BATCH) {
      const res = await client.quotes(keys.slice(i, i + QUOTE_BATCH));
      if (!res.ok) {
        console.warn('[quote-poller] fallback poll error:', res.error.message);
        continue;
      }
      for (const q of res.value) {
        // Intraday, a quote's ohlc.close is the LTP itself; the previous close
        // is LTP minus net_change. Using ohlc.close pinned day change at 0%.
        const prevClose = q.net_change != null ? q.last_price - q.net_change : undefined;
        applyTick({
          instrumentKey: q.instrument_token,
          ltp: q.last_price,
          ts: clock.ms(),
          // Indices report no volume; leave it out rather than feed the candle builder a null.
          ...(q.volume != null ? { volume: q.volume } : {}),
          ...(prevClose !== undefined && prevClose > 0 ? { close: prevClose } : {}),
        });
        const s = watchlist.get(q.instrument_token);
        if (s && q.ohlc) {
          if (q.ohlc.open && q.ohlc.open > 0) s.open = q.ohlc.open;
          if (q.ohlc.high && q.ohlc.high > 0) s.high = Math.max(s.high, q.ohlc.high);
          if (q.ohlc.low && q.ohlc.low > 0) s.low = s.low === 0 ? q.ohlc.low : Math.min(s.low, q.ohlc.low);
        }
      }
    }
  } catch (err) {
    console.warn('[quote-poller] fallback poll error:', err instanceof Error ? err.message : err);
  } finally {
    pollingInProgress = false;
  }
}

function startLoops(): void {
  // Strategy records drive the losing-strategy pause; trades also refresh them on close.
  void refreshStrategyRecords().catch((e) => console.error('[records]', e));
  setInterval(() => void refreshStrategyRecords().catch((e) => console.error('[records]', e)), 60_000);

  // Resilient market feed poller: if the WebSocket feed has not ticked recently
  // (e.g. during connection, backoff, or when waiting for user OAuth login),
  // poll REST quotes (/v2/market-quote/quotes) using the long-lived analytics token.
  // This keeps watchlist prices fresh, ensures staleness stays < 2500ms, and prevents
  // the FEED_STALE breaker from tripping.
  setInterval(() => {
    const mins = istMinutes(clock.now());
    if (mins < SESSION.OPEN - 15 || mins > SESSION.CLOSE + 15) return;
    const staleness = state.lastTickMs === null ? Infinity : clock.ms() - state.lastTickMs;
    if (staleness >= 2500) {
      void pollQuotesOnce();
    }
  }, 2_000);
  setInterval(() => {
    void liveCycle().catch((e) => console.error('[live]', e));
  }, cfg.TF_ANALYSIS_INTERVAL_MS);

  // The day's movers, from 09:20 (the open's quotes settled) to the last entry.
  setInterval(() => {
    const mins = istMinutes(clock.now());
    const due = clock.ms() - autoUniverse.attemptedAt >= AUTO_UNIVERSE_REFRESH_MS;
    if (!state.auto.autoUniverse || (due && mins >= SESSION.ENTRY_START && mins < SESSION.ENTRY_END)) {
      void refreshAutoUniverse();
    }
  }, 30_000);

  // Exits: EOD square-off, time stops, per-trade loss. Unless a breaker that
  // also blocks exits (divergence, maintenance) is tripped — then a human acts.
  setInterval(() => {
    if (!verdictNow().allowExits) return;
    void trader.manage(ltpOf).catch((e) => console.error('[manage]', e));
  }, 1_000);

  // Live fills are pulled; the portfolio stream only makes them arrive sooner.
  setInterval(() => {
    if (upstoxBroker && trader.live().some((p) => p.broker === 'UPSTOX')) void upstoxBroker.sync();
  }, 3_000);

  // Transitions the database missed while it was unreachable.
  setInterval(() => {
    if (journalBacklog.size > 0) void flushJournal();
  }, 5_000);

  // A long-running engine must re-seed each morning: daily bars are fetched once
  // and never extended by ticks, so swing strategies would otherwise keep
  // reading the boot day's history, and yesterday's 5-min bars must move into
  // the warmup history.
  setInterval(() => {
    const mins = istMinutes(clock.now());
    if (warmupDay === istDateKey(clock.now()) || mins < SESSION.OPEN - 10 || mins > SESSION.CLOSE) return;
    void seedWarmupCandles().catch((e) => console.error('[warmup] daily reseed', e));
  }, 60_000);

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

/** IST date the candle caches were last seeded for. */
let warmupDay = '';

async function seedWarmupCandles(): Promise<void> {
  console.log('[warmup] fetching prior sessions, today and daily bars from Upstox REST...');
  warmupDay = istDateKey(clock.now());
  const keys = [...new Set([
    ...watchlist.keys(), ...fnoDesk.feedKeys(),
    ...(state.focus ? [state.focus.instrumentKey] : []),
    ...(state.singleTarget ? [state.singleTarget.instrumentKey] : []),
  ])];
  for (const key of keys) {
    await loadCandles(key);
    const stock = watchlist.get(key);
    // The tick handler rebuilds today's range from 0; yesterday's must not leak in.
    if (stock) Object.assign(stock, { open: 0, high: 0, low: 0 });
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

// ─────────────────────────────── restart recovery ───────────────────────────────

/** Re-apply the dashboard's last settings. Anything that no longer validates falls back to the env defaults. */
async function restoreSettings(): Promise<void> {
  let s: PersistedSettings | null;
  try {
    s = await settingsStore.get<PersistedSettings>('settings');
  } catch (e) {
    console.error('[settings] could not load — using env defaults:', e instanceof Error ? e.message : e);
    return;
  }
  if (!s) return;

  // The desk is loaded later in boot when this is set (see main()).
  if (typeof s.fnoEnabled === 'boolean') state.fnoEnabled = s.fnoEnabled;
  const parsed = AutoConfigSchema.safeParse({ ...s.auto, enabled: state.auto.enabled });
  if (parsed.success) {
    state.auto = {
      ...parsed.data,
      strategies: parsed.data.strategies.filter((id) => STRATEGY_CATALOG.some((d) => d.id === id)),
      segments: { ...parsed.data.segments, fno: parsed.data.segments.fno && state.fnoEnabled },
    };
    const m = modeForSegments(state.auto.segments);
    if (m) {
      state.strategyMode = m;
      strategyManager.setMode(m);
    }
  }
  if (s.sizing) {
    if (s.sizing.mode === 'FIXED_QTY' || s.sizing.mode === 'FIXED_BUDGET' || s.sizing.mode === 'RISK_BASED') state.sizingMode = s.sizing.mode;
    if (s.sizing.budget > 0) state.budget = s.sizing.budget;
    if (s.sizing.fixedQty > 0) state.fixedQty = Math.floor(s.sizing.fixedQty);
    if (s.sizing.riskPct > 0 && s.sizing.riskPct <= 5) state.riskPct = s.sizing.riskPct;
  }
  for (const w of (s.watchlistExtra ?? []).slice(0, MAX_WATCHLIST_EXTRA)) {
    const eq = resolveEquity(w.symbol);
    if (!eq) continue;
    const item = { ...eq, name: w.name || eq.symbol };
    watchlistExtra.set(eq.instrumentKey, item);
    addWatch(item);
  }
  if (state.auto.targetMode === 'SINGLE_STOCK') {
    const eq = resolveEquity(state.auto.targetSymbol.toUpperCase());
    if (eq) {
      state.singleTarget = eq;
      state.focus = eq;
    } else {
      console.warn(`[settings] SINGLE_STOCK target ${state.auto.targetSymbol} not found — scope reset to ALL_SCANNED`);
      state.auto = { ...state.auto, targetMode: 'ALL_SCANNED' };
    }
  }
  console.log(`[settings] restored — mode ${state.strategyMode}, scope ${state.auto.targetMode}${state.singleTarget ? ` ${state.singleTarget.symbol}` : ''}, sizing ${state.sizingMode}, +${watchlistExtra.size} watchlist`);
}

const istDayStartMs = (): number => new Date(`${istDateKey(clock.now())}T00:00:00+05:30`).getTime();

/** Restored Upstox positions whose broker facts could not be read yet (no trading token at boot). */
const unverified = new Set<string>();

/**
 * Read what Upstox says about journaled positions: does each bracket still
 * exist, and did a leg fire on an order today's book no longer shows? Null for
 * a position whose GTT could not be read — it stays unverified.
 */
async function upstoxViews(ps: readonly ManagedPosition[]): Promise<Map<string, UpstoxView | null>> {
  const out = new Map<string, UpstoxView | null>();
  if (tokens.trading() === null || ps.length === 0) return out;
  const book = await client.orderBook();
  if (!book.ok) return out;
  const onBook = new Set(book.value.map((o) => o.order_id));
  for (const p of ps) {
    if (!p.gttOrderId) continue;
    const g = await client.getGtt(p.gttOrderId);
    if (!g.ok) { out.set(p.id, null); continue; }
    const gtt = g.value.find((d) => d.gtt_order_id === p.gttOrderId);
    out.set(p.id, {
      gttFound: gtt !== undefined,
      exitOrdersOffBook: (gtt?.rules ?? [])
        .filter((r) => (r.strategy === 'TARGET' || r.strategy === 'STOPLOSS') && r.order_id && !onBook.has(r.order_id))
        .map((r) => r.order_id!),
    });
  }
  return out;
}

/** Walk a filled position forward to MANAGING through the legal transitions. */
async function toManaging(p: ManagedPosition): Promise<void> {
  if (p.state === 'ENTRY_FILLED') await positionMachine.transition(p, 'BRACKET_ARMED');
  if (p.state === 'BRACKET_ARMED') await positionMachine.transition(p, 'MANAGING');
}

const paperBracketOf = (p: ManagedPosition) => ({
  positionId: p.id, instrumentKey: p.instrumentKey, side: p.side, quantity: p.filledQuantity,
  product: p.product, entryTrigger: 'IMMEDIATE' as const, entryPrice: p.avgEntry ?? p.entry,
  targetPrice: p.target, stopLossPrice: p.stopLoss, ...(p.trailingGap ? { trailingGap: p.trailingGap } : {}),
});

/**
 * Replay the journal after a (re)start: every non-terminal position is dropped,
 * re-attached to its own broker, finished, or flagged ORPHANED for a human —
 * per `planRecovery`. Today's risk counters are rebuilt from the same journal.
 */
async function recoverPositions(): Promise<void> {
  const open = await positionStore.loadOpen();
  const todays = await positionStore.loadSince(istDayStartMs());
  trader.restoreDay(todays);
  // The daily entry cap counts entries the broker accepted (act() counts r.ok);
  // a restart must not hand autonomous mode a fresh day's quota.
  const today = istDateKey(clock.now());
  state.autoEntries = {
    day: today,
    count: todays.filter((p) => istDateKey(new Date(p.openedAt)) === today && p.state !== 'REJECTED').length,
  };
  if (open.length === 0) return;

  const live = open.filter((p) => p.broker === 'UPSTOX');
  if (live.length > 0) trader.register('UPSTOX', ensureUpstoxBroker());
  const views = await upstoxViews(live.filter((p) => p.state !== 'ORPHANED'));
  const summary: Record<string, number> = {};

  for (const p of open) {
    const plan = planRecovery(p, today, views.get(p.id) ?? null);
    summary[plan.kind] = (summary[plan.kind] ?? 0) + 1;
    trader.restore(p);
    try {
      switch (plan.kind) {
        case 'DROP':
          p.exitReason = plan.reason;
          await positionMachine.transition(p, plan.to);
          break;
        case 'ORPHAN':
          p.exitReason = plan.reason;
          await positionMachine.orphan(p, plan.reason);
          break;
        case 'EXIT_NEXT_TICK':
          paperBroker.adopt({ gttOrderId: p.gttOrderId ?? `gtt-restored-${p.id}`, order: paperBracketOf(p), fillPrice: p.avgEntry ?? p.entry, exitPending: true });
          p.gttOrderId ??= `gtt-restored-${p.id}`;
          await toManaging(p);
          if (p.state === 'MANAGING') {
            p.exitReason = plan.reason;
            await positionMachine.transition(p, 'EXIT_TRIGGERED');
          }
          break;
        case 'ADOPT':
          if (p.state === 'ORPHANED') break;
          if (p.broker === 'PAPER') {
            paperBroker.adopt({ gttOrderId: p.gttOrderId ?? `gtt-restored-${p.id}`, order: paperBracketOf(p), fillPrice: p.avgEntry ?? p.entry, exitPending: false });
            p.gttOrderId ??= `gtt-restored-${p.id}`;
          } else {
            ensureUpstoxBroker().adopt({
              positionId: p.id, gttOrderId: p.gttOrderId!, instrumentKey: p.instrumentKey,
              side: p.side, product: p.product, entryDone: p.filledQuantity > 0,
            });
            if (!views.get(p.id)) unverified.add(p.id);
          }
          await toManaging(p);
          break;
      }
    } catch (e) {
      console.error(`[recovery] ${p.symbol} (${p.id}) — ${plan.kind} failed:`, e instanceof Error ? e.message : e);
    }
    console.log(`[recovery] ${p.broker} ${p.symbol} ${p.side} x${p.filledQuantity} → ${plan.kind}${'reason' in plan ? ` (${plan.reason})` : ''} → ${p.state}`);
  }
  await audit(sql, { kind: 'RECONCILE', actor: 'engine', mode: currentMode(), payload: { restored: open.length, ...summary, unverified: unverified.size } });
}

/** Once a trading token arrives, verify the live positions that were adopted blind at boot. */
async function reverifyUpstox(): Promise<void> {
  const ps = [...unverified].map((id) => trader.positions.get(id)).filter((p): p is ManagedPosition => p !== undefined && p.state !== 'ORPHANED');
  const views = await upstoxViews(ps);
  const today = istDateKey(clock.now());
  for (const p of ps) {
    const view = views.get(p.id);
    if (!view) continue;
    unverified.delete(p.id);
    const plan = planRecovery(p, today, view);
    if (plan.kind === 'ORPHAN') {
      p.exitReason = plan.reason;
      await positionMachine.orphan(p, plan.reason);
    }
  }
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
    broker: p.broker,
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
    filledAt: p.filledAt,
    closedAt: p.closedAt,
    exitPrice: p.exitPrice !== null ? paiseToRupees(p.exitPrice) : null,
    exitReason: p.exitReason,
    style: p.style,
    strategyId: p.strategyId ?? null,
    strategyVersion: p.strategyVersion ?? null,
    quality: p.quality ?? null,
    capitalRupees: paiseToRupees(p.costPaise),
    // Best and worst move per unit while open, in rupees.
    mfeRupees: paiseToRupees(p.mfePaise as Paise),
    maeRupees: paiseToRupees(p.maePaise as Paise),
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
      priceSource: priceSource(), feedIssue,
      allowEntries: v.allowEntries, allowExits: v.allowExits, trips: v.trips.map((t) => t.id),
    });
  }

  if (url.pathname === '/state') {
    const snap = snapshot();
    const v = evaluate(snap, cfg.limits, clock);
    // Informational momentum ranking of the watched set; autonomous entries rank by hybrid quality (/analysis/live).
    const ranked = stockScanner.rankUniverse([...watchlist.values()], liveBars(watchlist.keys()), {
      minPrice: state.auto.minPrice,
      maxPrice: state.auto.maxPrice,
    });
    return json(200, {
      mode: currentMode(),
      baseMode: state.arm.mode,
      isArmed: currentMode() === 'LIVE',
      armedUntilMs: state.arm.armedUntilMs,
      liveCapable: trader.activeBroker === 'UPSTOX',
      journalBacklog: journalBacklog.size,
      autoTrading: state.auto.enabled,
      autoTargetMode: state.auto.targetMode ?? 'ALL_SCANNED',
      autoTargetSymbol: state.auto.targetSymbol ?? 'RELIANCE',
      autoMinPrice: state.auto.minPrice ?? 0,
      autoMaxPrice: state.auto.maxPrice ?? 500000,
      autoTradeSide: state.auto.tradeSide,
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
        priceSource: priceSource(),
        feedIssue,
        ordersCount: trader.ordersToday,
        signalsCount: state.signalsCount,
      },
      watchlist: [...watchlist.values()].map((w) => ({
        ...w, bars: intradayCandlesCache.get(w.instrumentKey)?.length ?? 0, autoPicked: autoPicks.has(w.instrumentKey),
      })),
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
      autoUniverse: autoUniverseView(),
      autoLog,
      priceSource: priceSource(),
      feedIssue,
      breakers: verdictNow().trips.map((t) => ({ id: t.id, detail: t.detail })),
      fno: {
        deskEnabled: state.fnoEnabled,
        instrument: cfg.TF_FNO_INSTRUMENT,
        maxLots: cfg.TF_FNO_MAX_LOTS,
        underlyings: [...fnoDesk.states.values()].map((d) => ({
          symbol: d.symbol, expiry: d.expiry, lotSize: d.lotSize, error: d.error,
          spot: ltpOf(d.underlyingKey) ?? d.chain?.spot ?? null,
        })),
      },
      strategies: STRATEGY_CATALOG.map((d) => ({
        id: d.id, name: d.name, style: d.style, approved: registry.approved(d.id)?.id ?? null,
        record: strategyRecords.get(d.id) ?? null,
        verdict: registry.activeVerdict(d.id),
      })),
    });
  }

  if (url.pathname === '/auto/config' && req.method === 'GET') return json(200, state.auto);

  if (url.pathname === '/watchlist' && req.method === 'GET') {
    return json(200, {
      max: MAX_WATCHLIST_EXTRA,
      default: DEFAULT_UNIVERSE.map((u) => u.symbol),
      added: [...watchlistExtra.values()].map((w) => ({ ...w, bars: intradayCandlesCache.get(w.instrumentKey)?.length ?? 0 })),
      autoUniverse: autoUniverseView(),
    });
  }

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
      persistTradingToken(ex.value.accessToken);
      await audit(sql, { kind: 'TOKEN_REFRESH', actor: 'engine', mode: currentMode(), payload: { success: true } });
      void startPortfolioFeed();
      void feed.reconnect().catch((e) => console.error('[feed reconnect failed]', e));
      void reverifyUpstox().catch((e) => console.error('[recovery] re-verify', e));
      return json(200, { ok: true, expiresAt: tokens.msUntilExpiry() });
    }

    case '/scanner/analyze': {
      const symbol = String(body['symbol'] ?? 'RELIANCE').toUpperCase();
      const item = [...watchlist.values()].find((u) => u.symbol === symbol);
      if (!item) return json(404, { error: `${symbol} is not on the live watchlist` });
      const scored = stockScanner.rankUniverse([item], liveBars([item.instrumentKey]))[0];
      if (!scored?.tradeSetup) return json(404, { error: `not enough candles to analyse ${symbol}` });
      const sig = stockScanner.toSignal(scored, state.strategyMode === 'SWING' ? 'SWING' : 'INTRADAY');
      const consensus = await aiReviewer.review(sig);
      return json(200, { stock: scored, tradeSetup: scored.tradeSetup, signal: sig, consensus, votes: consensus.votes });
    }

    case '/strategy/autotrade': {
      const enabled = typeof body['enabled'] === 'boolean' ? body['enabled'] : !state.auto.enabled;
      const targetMode = body['targetMode'] === 'SINGLE_STOCK' ? 'SINGLE_STOCK' : body['targetMode'] === 'ALL_SCANNED' ? 'ALL_SCANNED' : state.auto.targetMode ?? 'ALL_SCANNED';
      const targetSymbol = typeof body['targetSymbol'] === 'string' && body['targetSymbol'].trim()
        ? body['targetSymbol'].trim().toUpperCase()
        : state.auto.targetSymbol ?? 'RELIANCE';

      // Turning autonomy off must never be refused, whatever the target.
      if (targetMode === 'SINGLE_STOCK' && state.singleTarget?.symbol !== targetSymbol) {
        const bad = await setSingleTarget(targetSymbol);
        if (bad && enabled) return json(404, { error: bad });
      }
      state.auto = {
        ...state.auto,
        enabled,
        targetMode,
        targetSymbol,
      };
      await audit(sql, { kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(), payload: { auto: state.auto as never } });

      persistSettings();
      return json(200, {
        autoTrading: state.auto.enabled,
        targetMode: state.auto.targetMode,
        targetSymbol: state.auto.targetSymbol,
      });
    }

    case '/strategy/target': {
      const targetMode = body['targetMode'] === 'SINGLE_STOCK' ? 'SINGLE_STOCK' : 'ALL_SCANNED';
      const targetSymbol = typeof body['targetSymbol'] === 'string' && body['targetSymbol'].trim()
        ? body['targetSymbol'].trim().toUpperCase()
        : state.auto.targetSymbol ?? 'RELIANCE';

      if (targetMode === 'SINGLE_STOCK') {
        const bad = await setSingleTarget(targetSymbol);
        if (bad) return json(404, { error: bad });
      }
      state.auto = {
        ...state.auto,
        targetMode,
        targetSymbol,
      };

      persistSettings();
      return json(200, {
        targetMode: state.auto.targetMode,
        targetSymbol: state.auto.targetSymbol,
      });
    }

    case '/strategy/filters': {
      // 1. Target Scope
      const targetMode = body['targetMode'] === 'SINGLE_STOCK' ? 'SINGLE_STOCK' : body['targetMode'] === 'ALL_SCANNED' ? 'ALL_SCANNED' : state.auto.targetMode ?? 'ALL_SCANNED';
      const targetSymbol = typeof body['targetSymbol'] === 'string' && body['targetSymbol'].trim()
        ? body['targetSymbol'].trim().toUpperCase()
        : state.auto.targetSymbol ?? 'RELIANCE';

      // 2. Price Filters (Rupees)
      let minPrice = state.auto.minPrice ?? 0;
      let maxPrice = state.auto.maxPrice ?? 500000;
      if (body['minPrice'] !== undefined) {
        const val = Number(body['minPrice']);
        minPrice = Number.isFinite(val) && val >= 0 ? val : 0;
      }
      if (body['maxPrice'] !== undefined) {
        const val = Number(body['maxPrice']);
        maxPrice = Number.isFinite(val) && val > 0 ? val : 500000;
      }
      // An inverted range blocks every setup, which looks exactly like "no signals".
      if (minPrice > 0 && maxPrice < 500000 && minPrice > maxPrice) {
        return json(400, { error: `min price ₹${minPrice} is above max price ₹${maxPrice}` });
      }

      // Validate everything that can fail before changing anything.
      if (targetMode === 'SINGLE_STOCK') {
        const bad = await setSingleTarget(targetSymbol);
        if (bad) return json(404, { error: bad });
      }

      const side = body['tradeSide'];
      const tradeSide = side === 'BUY' || side === 'SELL' || side === 'BOTH' ? side : state.auto.tradeSide;
      if (tradeSide !== state.auto.tradeSide) autoUniverse.attemptedAt = 0; // re-pick for the new direction now

      state.auto = {
        ...state.auto,
        targetMode,
        targetSymbol,
        minPrice,
        maxPrice,
        tradeSide,
      };

      // 3. Strategy Mode — drives which segments the live loop may enter.
      const stratMode = body['strategyMode'];
      if (stratMode === 'INTRADAY' || stratMode === 'SWING' || stratMode === 'BOTH') setStrategyMode(stratMode);

      // 4. Sizing Mode & Values
      const szMode = body['sizingMode'];
      if (szMode === 'FIXED_QTY' || szMode === 'FIXED_BUDGET' || szMode === 'RISK_BASED') {
        state.sizingMode = szMode;
      }
      if (body['budget'] !== undefined) {
        const b = Number(body['budget']);
        if (Number.isFinite(b) && b > 0) state.budget = b;
      }
      if (body['fixedQty'] !== undefined) {
        const q = Number(body['fixedQty']);
        if (Number.isFinite(q) && q > 0) state.fixedQty = Math.floor(q);
      }
      if (body['riskPct'] !== undefined) {
        const r = Number(body['riskPct']);
        if (Number.isFinite(r) && r > 0 && r <= 5) state.riskPct = r;
      }

      // 5. Optional Auto-Trading toggle
      if (typeof body['enabled'] === 'boolean') {
        state.auto.enabled = body['enabled'];
      }
      await audit(sql, {
        kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(),
        payload: { auto: state.auto as never, strategyMode: state.strategyMode, sizingMode: state.sizingMode },
      });

      persistSettings();
      return json(200, {
        ok: true,
        autoTrading: state.auto.enabled,
        targetMode: state.auto.targetMode,
        targetSymbol: state.auto.targetSymbol,
        minPrice: state.auto.minPrice,
        maxPrice: state.auto.maxPrice,
        tradeSide: state.auto.tradeSide,
        strategyMode: state.strategyMode,
        sizing: {
          mode: state.sizingMode,
          budget: state.budget,
          fixedQty: state.fixedQty,
          riskPct: state.riskPct,
        },
      });
    }

    case '/strategy/mode': {
      const m = body['mode'];
      if (m !== 'INTRADAY' && m !== 'SWING' && m !== 'BOTH') {
        return json(400, { error: 'invalid mode; must be INTRADAY, SWING, or BOTH' });
      }
      setStrategyMode(m);
      persistSettings();
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
      persistSettings();
      return json(200, { sizingMode: state.sizingMode, budget: state.budget, fixedQty: state.fixedQty, riskPct: state.riskPct });
    }

    case '/positions/resolve': {
      const kind = body['resolution'];
      const note = String(body['note'] ?? '').trim();
      if (kind !== 'CLOSED' && kind !== 'MANAGING') return json(400, { error: 'resolution must be CLOSED or MANAGING' });
      if (note.length < 3) return json(400, { error: 'add a note saying what you verified at the broker' });
      let exitPrice: Paise | null = null;
      if (kind === 'CLOSED' && body['exitPrice'] !== undefined && body['exitPrice'] !== null && body['exitPrice'] !== '') {
        const px = Number(body['exitPrice']);
        if (!Number.isFinite(px) || px <= 0) return json(400, { error: 'exitPrice must be a positive number of rupees' });
        exitPrice = rupeesToPaise(px);
      }
      const positionId = String(body['positionId'] ?? '');
      const r = await trader.resolveOrphan(positionId, kind === 'CLOSED' ? { kind, exitPrice, note } : { kind, note });
      if (!r.ok) return json(409, { error: r.detail });
      const p = trader.positions.get(positionId)!;
      if (kind === 'MANAGING') {
        // Re-attach to its broker so its bracket's fills are followed again.
        if (p.broker === 'UPSTOX' && p.gttOrderId) {
          ensureUpstoxBroker().adopt({
            positionId: p.id, gttOrderId: p.gttOrderId, instrumentKey: p.instrumentKey,
            side: p.side, product: p.product, entryDone: true,
          });
        } else if (p.broker === 'PAPER') {
          p.gttOrderId ??= `gtt-restored-${p.id}`;
          paperBroker.adopt({ gttOrderId: p.gttOrderId, order: paperBracketOf(p), fillPrice: p.avgEntry ?? p.entry, exitPending: false });
        }
      }
      await audit(sql, { kind: 'RECONCILE', actor: 'user', mode: currentMode(), positionId, payload: { resolution: kind, note, exitPrice: exitPrice !== null ? paiseToRupees(exitPrice) : null } });
      return json(200, { ok: true, detail: r.detail, state: p.state });
    }

    case '/watchlist/add': {
      const symbols = (Array.isArray(body['symbols']) ? body['symbols'] : [body['symbol']])
        .map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean);
      if (symbols.length === 0) return json(400, { error: 'symbol or symbols[] required' });
      const added: string[] = [];
      const failed: Array<{ symbol: string; error: string }> = [];
      for (const s of symbols.slice(0, MAX_WATCHLIST_EXTRA)) {
        const bad = await addToWatchlist(s);
        if (bad) failed.push({ symbol: s, error: bad }); else added.push(s);
      }
      if (added.length === 0) return json(409, { error: failed.map((f) => f.error).join('; '), added, failed });
      persistSettings();
      return json(200, { added, failed, size: watchlistExtra.size, max: MAX_WATCHLIST_EXTRA });
    }

    case '/watchlist/remove': {
      const bad = removeFromWatchlist(String(body['symbol'] ?? '').trim().toUpperCase());
      if (bad) return json(409, { error: bad });
      persistSettings();
      return json(200, { ok: true, size: watchlistExtra.size });
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
      if (requestedMode === 'PAPER') return json(200, await disarm({ switchedFromDashboard: true }));

      // Enforced here, not in the browser: a stray or scripted POST must not arm real money.
      if (body['confirmation'] !== LIVE_CONFIRMATION) {
        return json(400, { error: `To arm LIVE, type the confirmation phrase exactly: ${LIVE_CONFIRMATION}` });
      }
      if (tokens.trading() === null) {
        return json(409, { error: 'No Upstox trading token — click "Login with Upstox" first to authenticate for live trading.' });
      }

      const pf = await preflight(sql, client, clock, { requireTrading: true });
      const failed = pf.checks.filter((c) => !c.passed && c.hard);
      if (failed.length > 0) {
        return json(409, { error: `Preflight failed: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}` });
      }

      // Open paper positions stay on the paper broker; only new entries go to Upstox.
      trader.setBroker('UPSTOX', ensureUpstoxBroker());
      state.arm = armUntilSessionEnd(clock, 'user');
      await audit(sql, { kind: 'ARM', actor: 'user', mode: currentMode(), payload: { until: state.arm.armedUntilMs } });
      void startPortfolioFeed();
      if (!feed.isConnected) void feed.reconnect().catch((e) => console.error('[feed reconnect error]', e));
      return json(200, { mode: currentMode(), armedUntilMs: state.arm.armedUntilMs });
    }

    case '/mode/disarm':
      return json(200, await disarm({}));

    case '/fno/toggle': {
      const bad = await setFnoDesk(typeof body['enabled'] === 'boolean' ? body['enabled'] : !state.fnoEnabled);
      if (bad) return json(502, { error: bad });
      persistSettings();
      return json(200, { enabled: state.fnoEnabled });
    }

    case '/auto/fno': {
      // One switch for autonomous F&O: loads the desk when needed and allows
      // (or stops) F&O entries. Turning it off leaves the desk for analysis.
      if (typeof body['enabled'] !== 'boolean') return json(400, { error: 'enabled must be true or false' });
      const on = body['enabled'];
      if (on) {
        const bad = await setFnoDesk(true);
        if (bad) return json(502, { error: bad });
      }
      state.auto = { ...state.auto, segments: { ...state.auto.segments, fno: on } };
      await audit(sql, { kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(), payload: { fnoAuto: on } });
      persistSettings();
      return json(200, { fnoAuto: state.auto.segments.fno, deskEnabled: state.fnoEnabled });
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
        decisionContext(),
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
      if (parsed.data.targetMode === 'SINGLE_STOCK' && state.singleTarget?.symbol !== parsed.data.targetSymbol.toUpperCase()) {
        const bad = await setSingleTarget(parsed.data.targetSymbol.toUpperCase());
        if (bad) return json(404, { error: bad });
      }
      state.auto = parsed.data;
      // Universe settings apply now, not in 5 minutes.
      autoUniverse.attemptedAt = 0;
      // Keep the dashboard's strategy mode truthful about what the loop enters.
      const m = modeForSegments(state.auto.segments);
      if (m) {
        state.strategyMode = m;
        strategyManager.setMode(m);
      }
      await audit(sql, { kind: 'MODE_CHANGE', actor: 'user', mode: currentMode(), payload: { auto: state.auto as never } });
      persistSettings();
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
      void upstoxBroker?.sync();
      return json(200, { accepted: true, action: 'resynced' });
  }

  return json(404, { error: 'not found' });
});

async function main(): Promise<void> {
  console.log(`TradeForger engine booting — TF_MODE ${cfg.TF_MODE}, strategy ${cfg.TF_AUTO_TRADING_MODE}, F&O ${cfg.TF_FNO_ENABLED ? cfg.TF_FNO_INSTRUMENT : 'off'}, IST ${istHHMM(clock.now())}`);
  // Fail closed: without the journal the engine cannot recover positions after
  // a restart, so it does not trade at all.
  const applied = await runMigrations(sql);
  console.log(`[db] schema ${applied.length ? `migrated: ${applied.join(', ')}` : 'up to date'}`);
  await audit(sql, {
    kind: 'ENGINE_BOOT', actor: 'engine', mode: cfg.TF_MODE,
    payload: { version: '0.3.0', sizingMode: cfg.TF_SIZING_MODE, strategyMode: cfg.TF_AUTO_TRADING_MODE, fno: cfg.TF_FNO_ENABLED },
  });

  if (cfg.TF_MODE === 'SANDBOX') {
    console.warn('SANDBOX has no market data or GTT support (docs/00-PLAN.md §0.3) — running the PAPER broker');
  }

  const pf = await preflight(sql, client, clock, { requireTrading: wantsLiveBroker });
  for (const c of pf.checks) console.log(`  ${c.passed ? '✓' : c.hard ? '✗' : '·'} ${c.name.padEnd(20)} ${c.detail}`);

  const live = wantsLiveBroker && pf.passed;
  if (wantsLiveBroker && !pf.passed) {
    console.warn('Preflight failed — running the PAPER broker; no order will reach Upstox this session');
    state.arm = { mode: 'PAPER', armedUntilMs: null, armedBy: null };
  }

  trader = new Trader({
    clock,
    broker: live ? ensureUpstoxBroker() : paperBroker,
    brokerId: live ? 'UPSTOX' : 'PAPER',
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

  await restoreSettings();
  // Before the loops start: nothing may enter until every journaled position is accounted for.
  await recoverPositions();

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
  await pollQuotesOnce();
  startLoops();

  try {
    await feed.connect();
  } catch (err) {
    console.error('[feed connect failed]', err);
  }
  void startPortfolioFeed();

  server.listen(cfg.TF_ENGINE_PORT, cfg.TF_ENGINE_HOST, () => {
    console.log(`✓ Control API on http://${cfg.TF_ENGINE_HOST}:${cfg.TF_ENGINE_PORT} (bearer auth required)`);
    console.log(`✓ Broker: ${trader.activeBroker === 'PAPER' ? 'PAPER' : 'UPSTOX (orders only while armed)'} · mode ${currentMode()}`);
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

