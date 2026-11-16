import { createServer, type ServerResponse } from 'node:http';
import {
  SystemClock, istHHMM, formatINR, rupeesToPaise, paiseToRupees,
  newPositionId, type Paise, type Candle, type Tick, type Side,
  type SizingMode, type Mode, type PositionId,
} from '@tradeforger/core';
import { db, audit, closeDb, type Sql } from '@tradeforger/db';
import { TokenStore, UpstoxClient } from '@tradeforger/upstox';
import { PaperBroker, UpstoxBroker, type BrokerPort } from '@tradeforger/broker';
import { evaluate, effectiveMode, fire, type RiskSnapshot, type ModeState } from '@tradeforger/safety';
import { MarketFeed } from '@tradeforger/feed';
import { CandleAggregator } from '@tradeforger/data';
import { size as sizePosition } from '@tradeforger/risk';
import {
  PositionMachine, type PositionRecord, reconcile, type BrokerPosition,
} from '@tradeforger/execution';
import {
  StrategyManager, type AutoTradingStrategyMode, IntradayProfile, SwingProfile,
  StockScanner, type ScoredStock,
} from '@tradeforger/strategy';
import { AiReviewer, type AiDecision } from '@tradeforger/ai';
import { loadConfig, type EngineConfig } from './config.ts';
import { preflight } from './preflight.ts';

const clock = SystemClock;
let cfg: EngineConfig;
try {
  cfg = loadConfig();
} catch (e) {
  console.error('[Config Error]', e);
  process.exit(1);
}

const sql = db(cfg.DATABASE_URL);

// Upstox token store and client
const tokens = new TokenStore(clock, {
  ...(cfg.UPSTOX_ANALYTICS_TOKEN ? { analyticsToken: cfg.UPSTOX_ANALYTICS_TOKEN } : {}),
});

const client = new UpstoxClient(tokens, {
  clock,
  onHalt: (e) => {
    console.error(`[HALT] ${e.kind}: ${e.message}`);
    state.manualHalt = true;
  },
});

// Auto trading strategies & AI reviewer
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
    ? {
        apiKey: cfg.GROQ_API_KEY,
        model: cfg.GROQ_MODEL,
        baseUrl: cfg.GROQ_BASE_URL,
        timeoutMs: 900,
      }
    : null,
});

// Brokers
const paperBroker = new PaperBroker(clock);
const upstoxBroker = new UpstoxBroker({ client, mode: cfg.TF_MODE, clock });
let activeBroker: BrokerPort = cfg.TF_MODE === 'LIVE' ? upstoxBroker : paperBroker;

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

const DEFAULT_UNIVERSE: Array<{ instrumentKey: string; symbol: string; name: string }> = [
  { instrumentKey: 'NSE_EQ|INE002A01018', symbol: 'RELIANCE', name: 'Reliance Industries' },
  { instrumentKey: 'NSE_EQ|INE467B01029', symbol: 'TCS', name: 'Tata Consultancy Services' },
  { instrumentKey: 'NSE_EQ|INE009A01021', symbol: 'INFY', name: 'Infosys Ltd' },
  { instrumentKey: 'NSE_EQ|INE040A01034', symbol: 'HDFCBANK', name: 'HDFC Bank Ltd' },
  { instrumentKey: 'NSE_EQ|INE090A01021', symbol: 'ICICIBANK', name: 'ICICI Bank Ltd' },
  { instrumentKey: 'NSE_EQ|INE062A01020', symbol: 'SBIN', name: 'State Bank of India' },
  { instrumentKey: 'NSE_EQ|INE397D01024', symbol: 'BHARTIARTL', name: 'Bharti Airtel Ltd' },
  { instrumentKey: 'NSE_EQ|INE018A01030', symbol: 'LT', name: 'Larsen & Toubro Ltd' },
  { instrumentKey: 'NSE_EQ|INE154A01025', symbol: 'ITC', name: 'ITC Ltd' },
  { instrumentKey: 'NSE_EQ|INE238A01034', symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank' },
  { instrumentKey: 'NSE_EQ|INE155A01022', symbol: 'TATAMOTORS', name: 'Tata Motors Ltd' },
];

const watchlist = new Map<string, WatchlistStock>();
for (const s of DEFAULT_UNIVERSE) {
  watchlist.set(s.instrumentKey, {
    ...s,
    ltp: 0,
    changePct: 0,
    open: 0,
    high: 0,
    low: 0,
    close: 0,
    volume: 0,
    lastUpdated: clock.ms(),
  });
}

// Candle aggregators and historical cache
const aggregator5m = new CandleAggregator(5);
const intradayCandlesCache = new Map<string, Candle[]>();
const dailyCandlesCache = new Map<string, Candle[]>();

// Recent signals and active positions
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
const positions = new Map<string, PositionRecord>();

// Position Machine
const positionMachine = new PositionMachine(async (p, from, to) => {
  await audit(sql, {
    kind: 'STATE_TRANSITION',
    actor: 'engine',
    mode: state.mode,
    positionId: p.id,
    payload: {
      symbol: p.symbol,
      from,
      to,
      qty: p.quantity,
      filled: p.filledQuantity,
    },
  });
});

// Runtime state
const state = {
  mode: cfg.TF_MODE as Mode,
  armedUntilMs: null as number | null,
  armedBy: null as string | null,
  autoTrading: true,
  strategyMode: cfg.TF_AUTO_TRADING_MODE,
  sizingMode: cfg.TF_SIZING_MODE as SizingMode,
  budget: cfg.TF_BUDGET,
  fixedQty: cfg.TF_FIXED_QTY ?? 10,
  riskPct: cfg.TF_RISK_PCT,
  manualHalt: false,
  startedAt: clock.ms(),
  ticks: 0,
  lastTickMs: null as number | null,
  signalsCount: 0,
  orders: [] as number[],
  realisedPnlPaise: 0 as Paise,
  consecutiveLosses: 0,
  rejectsLast5Min: 0,
  divergenceDetected: false,
};

function getModeState(): ModeState {
  return {
    mode: state.mode,
    armedUntilMs: state.armedUntilMs,
    armedBy: state.armedBy,
  };
}

function calculateUnrealisedPnlPaise(): Paise {
  let total = 0;
  for (const pos of positions.values()) {
    if (pos.filledQuantity <= 0 || !pos.avgEntry) continue;
    const stock = watchlist.get(pos.instrumentKey);
    if (!stock || stock.ltp <= 0) continue;
    const ltpPaise = rupeesToPaise(stock.ltp);
    const diff = pos.side === 'BUY' ? ltpPaise - pos.avgEntry : pos.avgEntry - ltpPaise;
    total += diff * pos.filledQuantity;
  }
  return total as Paise;
}

function snapshot(): RiskSnapshot {
  const unrealised = calculateUnrealisedPnlPaise();
  let worstLoss = 0;
  for (const pos of positions.values()) {
    if (pos.filledQuantity <= 0 || !pos.avgEntry) continue;
    const stock = watchlist.get(pos.instrumentKey);
    if (!stock || stock.ltp <= 0) continue;
    const ltpPaise = rupeesToPaise(stock.ltp);
    const diff = pos.side === 'BUY' ? ltpPaise - pos.avgEntry : pos.avgEntry - ltpPaise;
    const loss = diff * pos.filledQuantity;
    if (loss < worstLoss) worstLoss = loss;
  }

  return {
    startingCapitalPaise: (cfg.TF_MAX_DEPLOYED_CAPITAL * 100) as Paise,
    realisedPnlPaise: state.realisedPnlPaise,
    unrealisedPnlPaise: unrealised,
    openPositions: [...positions.values()].filter((p) => p.filledQuantity > 0).length,
    ordersToday: state.orders.length,
    consecutiveLosses: state.consecutiveLosses,
    rejectsLast5Min: state.rejectsLast5Min,
    orderTimestamps: state.orders,
    lastTickMs: state.lastTickMs,
    marginUtilisationPct: 0,
    divergenceDetected: state.divergenceDetected,
    manualHalt: state.manualHalt,
    worstOpenLossPaise: worstLoss as Paise,
  };
}

// Market Feed
const feed = new MarketFeed(async () => {
  const r = await client.marketFeedUrl();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, clock);

// Ingest ticks & run strategy
feed.on('tick', (t: Tick) => {
  state.ticks++;
  state.lastTickMs = clock.ms();

  // Forward tick to active broker simulator
  if (activeBroker instanceof PaperBroker) {
    activeBroker.onTick(t);
  }

  // Update watchlist quote
  const stock = watchlist.get(t.instrumentKey);
  if (stock) {
    const priorLtp = stock.ltp;
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

  // Push to aggregator
  const closedCandle = aggregator5m.push(t);
  if (closedCandle) {
    const arr = intradayCandlesCache.get(t.instrumentKey) ?? [];
    arr.push(closedCandle);
    if (arr.length > 120) arr.shift();
    intradayCandlesCache.set(t.instrumentKey, arr);

    // Evaluate strategy on candle close
    void evaluateStock(t.instrumentKey);
  }
});

feed.on('error', (e) => console.error('[feed]', e.message));
feed.on('open', () => {
  console.log('[feed] connected — subscribing universe');
  const keys = Array.from(watchlist.keys());
  const { accepted, rejected } = feed.subscribe(keys, 'full');
  console.log(`[feed] subscribed ${accepted.length} instruments, rejected ${rejected.length}`);
});
feed.on('close', (c, r) => console.warn(`[feed] closed ${c} ${r}`));

/**
 * Evaluates trade candidates for an instrument, runs free AI analysis,
 * checks pre-trade risk gates, and places bracket orders if confirmed.
 */
async function evaluateStock(instrumentKey: string): Promise<void> {
  if (!state.autoTrading) return;

  const stock = watchlist.get(instrumentKey);
  if (!stock || stock.ltp <= 0) return;

  // Check if position already exists in this symbol
  const existing = [...positions.values()].find(
    (p) => p.instrumentKey === instrumentKey && p.state !== 'CLOSED' && p.state !== 'REJECTED' && p.state !== 'CANCELLED',
  );
  if (existing) return;

  // Circuit breakers evaluation
  const curMode = effectiveMode(getModeState(), clock);
  const verdict = evaluate(snapshot(), cfg.limits, clock);
  if (!verdict.allowEntries) return;

  const intradayCandles = intradayCandlesCache.get(instrumentKey) ?? [];
  const dailyCandles = dailyCandlesCache.get(instrumentKey) ?? [];

  // Evaluate strategies (Intraday and/or Swing)
  const evaluated = strategyManager.evaluate({
    instrumentKey,
    symbol: stock.symbol,
    intradayCandles,
    dailyCandles,
    clock,
  });

  for (const { signal, product, profileName } of evaluated) {
    state.signalsCount++;

    // Run Free Real-Time AI Review (with Groq fallback if configured)
    const aiDecision = await aiReviewer.review(signal);

    const sigRecord: SignalWithAi = {
      id: signal.id,
      instrumentKey: signal.instrumentKey,
      symbol: signal.symbol,
      style: signal.style as 'INTRADAY' | 'SWING',
      side: signal.side,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      target: signal.target,
      confidence: signal.confidence,
      reasons: signal.reasons,
      ai: aiDecision,
      generatedAt: signal.generatedAt,
    };

    recentSignals.unshift(sigRecord);
    if (recentSignals.length > 50) recentSignals.pop();

    await audit(sql, {
      kind: 'SIGNAL_GENERATED',
      actor: 'engine',
      mode: curMode,
      signalId: signal.id,
      payload: {
        symbol: signal.symbol,
        style: signal.style,
        side: signal.side,
        entry: paiseToRupees(signal.entry),
        stopLoss: paiseToRupees(signal.stopLoss),
        target: paiseToRupees(signal.target),
        aiVerdict: aiDecision.verdict,
        aiConfidence: aiDecision.confidence,
        riskFlags: [...aiDecision.riskFlags],
        rationale: aiDecision.rationale,
      },
    });

    // If AI rejected the trade, stop here
    if (aiDecision.blocked) {
      console.log(`[AI BLOCKED] ${signal.symbol} ${signal.side}: ${aiDecision.rationale}`);
      continue;
    }

    // Risk Sizing
    const deployed = [...positions.values()]
      .filter((p) => p.filledQuantity > 0 && p.avgEntry)
      .reduce((sum, p) => sum + (p.avgEntry! * p.filledQuantity), 0) as Paise;

    const sizingInput = {
      mode: state.sizingMode,
      entry: signal.entry,
      stopLoss: signal.stopLoss,
      fixedQty: state.fixedQty,
      budget: rupeesToPaise(state.budget),
      riskPct: state.riskPct,
      capital: (cfg.TF_MAX_DEPLOYED_CAPITAL * 100) as Paise,
      availableMargin: (cfg.TF_MAX_DEPLOYED_CAPITAL * 100 - deployed) as Paise,
      lotSize: 1,
      avgDailyVolume: Math.max(stock.volume, 50_000),
      deployedCapital: deployed,
    };

    const sized = sizePosition(sizingInput, cfg.limits);
    if (!sized.ok) {
      console.log(`[SIZING REJECT] ${signal.symbol}: ${sized.reason} - ${sized.detail}`);
      continue;
    }

    // Apply AI size multiplier (e.g. CAUTION halves position size)
    const finalQty = Math.max(1, Math.floor(sized.result.quantity * aiDecision.sizeMultiplier));
    const positionId = newPositionId();

    const positionRecord: PositionRecord = {
      id: positionId,
      instrumentKey: signal.instrumentKey,
      symbol: signal.symbol,
      side: signal.side,
      state: 'CANDIDATE',
      quantity: finalQty,
      filledQuantity: 0,
      entry: signal.entry,
      avgEntry: null,
      stopLoss: signal.stopLoss,
      target: signal.target,
      entryOrderId: null,
      gttOrderId: null,
      openedAt: clock.ms(),
    };

    positions.set(positionId, positionRecord);

    try {
      await positionMachine.transition(positionRecord, 'AI_REVIEWED');
      await positionMachine.transition(positionRecord, 'RISK_APPROVED');

      // Place entry order
      await positionMachine.transition(positionRecord, 'ENTRY_SENT');
      state.orders.push(clock.ms());

      const orderRes = await activeBroker.placeOrder({
        positionId,
        instrumentKey: signal.instrumentKey,
        side: signal.side,
        quantity: finalQty,
        orderType: 'MARKET',
        product,
        validity: 'DAY',
        price: signal.entry,
        triggerPrice: signal.entry,
        tag: positionId,
      });

      if (!orderRes.ok) {
        state.rejectsLast5Min++;
        await positionMachine.transition(positionRecord, 'REJECTED');
        console.error(`[ORDER REJECT] ${signal.symbol}: ${orderRes.error.message}`);
        continue;
      }

      positionRecord.entryOrderId = orderRes.value.brokerOrderId;
      await positionMachine.transition(positionRecord, 'ENTRY_ACKED');

      // For PaperBroker, market orders fill immediately. For Live, fills arrive via portfolio stream or reconciler.
      if (activeBroker instanceof PaperBroker) {
        positionRecord.filledQuantity = finalQty;
        positionRecord.avgEntry = signal.entry;
        await positionMachine.transition(positionRecord, 'ENTRY_FILLED');

        // Place native OCO bracket
        const exitSide = signal.side === 'BUY' ? 'SELL' : 'BUY';
        const bracketRes = await activeBroker.placeBracket({
          instrumentKey: signal.instrumentKey,
          quantity: finalQty,
          product,
          exitSide,
          targetPrice: signal.target,
          stopLossPrice: signal.stopLoss,
        });

        if (bracketRes.ok) {
          positionRecord.gttOrderId = bracketRes.value.gttOrderId;
          await positionMachine.transition(positionRecord, 'BRACKET_ARMED');
          await positionMachine.transition(positionRecord, 'MANAGING');
          console.log(`[TRADE OPEN] ${signal.symbol} ${signal.side} x${finalQty} @ ₹${paiseToRupees(signal.entry)} (SL: ₹${paiseToRupees(signal.stopLoss)}, Target: ₹${paiseToRupees(signal.target)})`);
        } else {
          await positionMachine.orphan(positionRecord, `bracket failed: ${bracketRes.error.message}`);
        }
      }
    } catch (err) {
      console.error(`[EXECUTION ERROR] ${signal.symbol}:`, err);
    }
  }
}

// SSE Clients for live stream to the web UI
const sseClients = new Set<ServerResponse>();

function broadcastSse(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Periodic tick / status broadcaster
setInterval(() => {
  if (sseClients.size === 0) return;
  const snap = snapshot();
  const curMode = effectiveMode(getModeState(), clock);
  const verdict = evaluate(snap, cfg.limits, clock);

  broadcastSse('telemetry', {
    mode: curMode,
    istTime: istHHMM(clock.now()),
    uptimeMs: clock.ms() - state.startedAt,
    ticks: state.ticks,
    feedStaleness: feed.staleness(),
    allowEntries: verdict.allowEntries,
    allowExits: verdict.allowExits,
    trips: verdict.trips.map((t) => t.id),
    realisedPnl: paiseToRupees(state.realisedPnlPaise),
    unrealisedPnl: paiseToRupees(snap.unrealisedPnlPaise),
    openPositionsCount: snap.openPositions,
    signalsCount: state.signalsCount,
    strategyMode: state.strategyMode,
    autoTrading: state.autoTrading,
  });
}, 1500);

// Seed historical candles for indicators warmup
async function seedWarmupCandles(): Promise<void> {
  console.log('[warmup] fetching initial bars from Upstox REST...');
  for (const [key, stock] of watchlist.entries()) {
    try {
      const res = await client.intradayCandles(key, 'minutes', 5);
      if (res.ok && res.value.length > 0) {
        intradayCandlesCache.set(key, res.value);
        const lastBar = res.value[res.value.length - 1];
        if (lastBar) {
          stock.ltp = lastBar.close;
          stock.open = res.value[0]?.open ?? lastBar.open;
          stock.high = Math.max(...res.value.map((b) => b.high));
          stock.low = Math.min(...res.value.map((b) => b.low));
          stock.close = lastBar.close;
        }
      }
    } catch {
      // Continue on rate limit or market closed
    }
  }
  console.log(`[warmup] loaded historical bars for ${intradayCandlesCache.size} symbols`);
}

/**
 * Control API for Web Dashboard & Cloudflare Tunnel
 */
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  // SSE Stream
  if (url.pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // Health
  if (url.pathname === '/health') {
    const snap = snapshot();
    const verdict = evaluate(snap, cfg.limits, clock);
    return json(200, {
      ok: true,
      mode: effectiveMode(getModeState(), clock),
      strategyMode: state.strategyMode,
      autoTrading: state.autoTrading,
      istTime: istHHMM(clock.now()),
      uptimeMs: clock.ms() - state.startedAt,
      ticks: state.ticks,
      feedStaleness: feed.staleness(),
      subscribed: feed.subscribedCount,
      allowEntries: verdict.allowEntries,
      allowExits: verdict.allowExits,
      trips: verdict.trips.map((t) => t.id),
      realisedPnl: paiseToRupees(state.realisedPnlPaise),
      unrealisedPnl: paiseToRupees(snap.unrealisedPnlPaise),
    });
  }

  // Full state for Dashboard UI
  if (url.pathname === '/state') {
    const snap = snapshot();
    const verdict = evaluate(snap, cfg.limits, clock);
    const curMode = effectiveMode(getModeState(), clock);

    const positionsList = [...positions.values()].map((p) => {
      const stock = watchlist.get(p.instrumentKey);
      const ltp = stock?.ltp ?? 0;
      const ltpPaise = rupeesToPaise(ltp);
      const pnlPaise = p.avgEntry && p.filledQuantity > 0
        ? (p.side === 'BUY' ? ltpPaise - p.avgEntry : p.avgEntry - ltpPaise) * p.filledQuantity
        : 0;

      return {
        id: p.id,
        instrumentKey: p.instrumentKey,
        symbol: p.symbol,
        side: p.side,
        state: p.state,
        quantity: p.quantity,
        filledQuantity: p.filledQuantity,
        entry: paiseToRupees(p.entry),
        avgEntry: p.avgEntry ? paiseToRupees(p.avgEntry) : null,
        stopLoss: paiseToRupees(p.stopLoss),
        target: paiseToRupees(p.target),
        ltp,
        pnlRupees: paiseToRupees(pnlPaise as Paise),
        gttOrderId: p.gttOrderId,
        openedAt: p.openedAt,
      };
    });

    const watchlistArray = [...watchlist.values()].map((w) => ({
      ...w,
      bars: intradayCandlesCache.get(w.instrumentKey)?.length ?? 0,
    }));

    return json(200, {
      mode: curMode,
      baseMode: state.mode,
      isArmed: curMode === 'LIVE',
      autoTrading: state.autoTrading,
      strategyMode: state.strategyMode,
      sizing: {
        mode: state.sizingMode,
        budget: state.budget,
        fixedQty: state.fixedQty,
        riskPct: state.riskPct,
      },
      limits: {
        maxSpendPerTrade: cfg.TF_MAX_SPEND_PER_TRADE,
        maxDeployed: cfg.TF_MAX_DEPLOYED_CAPITAL,
        dailyLossLimitPct: cfg.TF_DAILY_LOSS_LIMIT_PCT,
      },
      pnl: {
        realised: paiseToRupees(state.realisedPnlPaise),
        unrealised: paiseToRupees(snap.unrealisedPnlPaise),
        total: paiseToRupees((state.realisedPnlPaise + snap.unrealisedPnlPaise) as Paise),
      },
      breakers: {
        allowEntries: verdict.allowEntries,
        allowExits: verdict.allowExits,
        trips: verdict.trips.map((t) => ({ id: t.id, message: t.message, blocks: t.blocks })),
      },
      telemetry: {
        istTime: istHHMM(clock.now()),
        uptimeMs: clock.ms() - state.startedAt,
        ticks: state.ticks,
        feedStaleness: feed.staleness(),
        subscribedCount: feed.subscribedCount,
        ordersCount: state.orders.length,
        signalsCount: state.signalsCount,
      },
      watchlist: watchlistArray,
      positions: positionsList,
      recentSignals,
      rankedStocks: stockScanner.rankUniverse(DEFAULT_UNIVERSE, intradayCandlesCache),
      topStock: stockScanner.rankUniverse(DEFAULT_UNIVERSE, intradayCandlesCache)[0] ?? null,
      auth: {
        hasTradingToken: tokens.trading() !== null,
        hasAnalyticsToken: tokens.data() !== null,
        tradingExpiresInMs: tokens.msUntilExpiry(),
        loginUrl: `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(cfg.UPSTOX_API_KEY)}&redirect_uri=${encodeURIComponent(cfg.UPSTOX_REDIRECT_URI)}`,
      },
    });
  }

  // Parse JSON body for POST requests
  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const str = Buffer.concat(chunks).toString('utf8');
      if (str) body = JSON.parse(str);
    } catch {
      // Empty or invalid body
    }
  }

  // OAuth Code Exchange
  if (url.pathname === '/auth/exchange' && req.method === 'POST') {
    const code = String(body['code'] ?? '');
    const redirectUri = String(body['redirectUri'] ?? cfg.UPSTOX_REDIRECT_URI);

    if (!code) {
      return json(400, { error: 'missing code' });
    }

    const exRes = await client.exchangeToken({
      code,
      clientId: cfg.UPSTOX_API_KEY,
      clientSecret: cfg.UPSTOX_API_SECRET,
      redirectUri,
    });

    if (exRes.ok) {
      tokens.setTrading(exRes.value.accessToken);
      console.log('✓ Successfully exchanged Upstox OAuth code and loaded trading token!');
      await audit(sql, {
        kind: 'TOKEN_REFRESH',
        actor: 'engine',
        mode: state.mode,
        payload: { success: true },
      });
      return json(200, { ok: true, expiresAt: tokens.msUntilExpiry() });
    } else {
      console.error('[auth exchange failed]', exRes.error);
      return json(400, { error: exRes.error.message, detail: exRes.error.body });
    }
  }

  // Auth Status
  if (url.pathname === '/auth/status') {
    return json(200, {
      hasTradingToken: tokens.trading() !== null,
      hasAnalyticsToken: tokens.data() !== null,
      tradingExpiresInMs: tokens.msUntilExpiry(),
      loginUrl: `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${encodeURIComponent(cfg.UPSTOX_API_KEY)}&redirect_uri=${encodeURIComponent(cfg.UPSTOX_REDIRECT_URI)}`,
    });
  }

  // Single Stock Deep Real-Time AI Analysis
  if (url.pathname === '/scanner/analyze' && req.method === 'POST') {
    const symbol = String(body['symbol'] ?? 'RELIANCE').toUpperCase();
    const universeItem = DEFAULT_UNIVERSE.find((u) => u.symbol === symbol) ?? DEFAULT_UNIVERSE[0]!;
    const ranked = stockScanner.rankUniverse([universeItem], intradayCandlesCache);
    const scoredStock = ranked[0] ?? null;

    if (!scoredStock || !scoredStock.tradeSetup) {
      return json(404, { error: `unable to generate setup for ${symbol}` });
    }

    const sig = stockScanner.toSignal(scoredStock, state.strategyMode === 'SWING' ? 'SWING' : 'INTRADAY');
    const consensus = await aiReviewer.review(sig);

    return json(200, {
      stock: scoredStock,
      tradeSetup: scoredStock.tradeSetup,
      signal: sig,
      consensus,
      votes: consensus.votes,
    });
  }

  // Auto-trading toggle
  if (url.pathname === '/strategy/autotrade' && req.method === 'POST') {
    state.autoTrading = Boolean(body['enabled'] ?? !state.autoTrading);
    return json(200, { autoTrading: state.autoTrading });
  }

  // Strategy Mode change (INTRADAY / SWING / BOTH)
  if (url.pathname === '/strategy/mode' && req.method === 'POST') {
    const newMode = body['mode'] as AutoTradingStrategyMode;
    if (newMode === 'INTRADAY' || newMode === 'SWING' || newMode === 'BOTH') {
      state.strategyMode = newMode;
      strategyManager.setMode(newMode);
      return json(200, { strategyMode: state.strategyMode });
    }
    return json(400, { error: 'invalid mode; must be INTRADAY, SWING, or BOTH' });
  }

  // Sizing mode & parameters
  if (url.pathname === '/sizing' && req.method === 'POST') {
    if (body['mode']) state.sizingMode = body['mode'] as SizingMode;
    if (body['budget']) state.budget = Number(body['budget']);
    if (body['fixedQty']) state.fixedQty = Number(body['fixedQty']);
    if (body['riskPct']) state.riskPct = Number(body['riskPct']);
    return json(200, {
      sizingMode: state.sizingMode,
      budget: state.budget,
      fixedQty: state.fixedQty,
      riskPct: state.riskPct,
    });
  }

  // Manual Position Exit
  if (url.pathname === '/positions/exit' && req.method === 'POST') {
    const positionId = body['positionId'] as string;
    const pos = positions.get(positionId);
    if (!pos) return json(404, { error: 'position not found' });

    try {
      if (pos.gttOrderId) await activeBroker.cancelBracket(pos.gttOrderId);
      const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      const r = await activeBroker.placeOrder({
        positionId: pos.id,
        instrumentKey: pos.instrumentKey,
        side: exitSide,
        quantity: pos.filledQuantity,
        orderType: 'MARKET',
        product: 'I',
        validity: 'DAY',
        price: pos.entry,
        triggerPrice: pos.entry,
        tag: `manual-exit-${pos.id}`,
      });

      if (r.ok) {
        await positionMachine.transition(pos, 'EXIT_TRIGGERED');
        await positionMachine.transition(pos, 'EXIT_FILLED');
        await positionMachine.transition(pos, 'CLOSED');
        return json(200, { success: true, positionId });
      }
      return json(500, { error: r.error.message });
    } catch (e) {
      return json(500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Kill Switch
  if (url.pathname === '/kill' && req.method === 'POST') {
    const level = (url.searchParams.get('level') ?? body['level'] ?? 'SOFT') as 'SOFT' | 'HARD' | 'NUCLEAR';
    void fire(
      level,
      {
        stopNewEntries: async () => {
          state.manualHalt = true;
          state.autoTrading = false;
        },
        cancelAllOpenOrders: async () => 0,
        cancelAllGtt: async () => {
          let count = 0;
          for (const pos of positions.values()) {
            if (pos.gttOrderId) {
              await activeBroker.cancelBracket(pos.gttOrderId);
              count++;
            }
          }
          return count;
        },
        exitAllPositions: async () => {
          const r = await activeBroker.exitAllPositions();
          for (const pos of positions.values()) {
            if (pos.filledQuantity > 0 && pos.state === 'MANAGING') {
              pos.state = 'CLOSED';
            }
          }
          return r.ok ? r.value : 0;
        },
        disableSegment: async (seg) => {
          await client.killSwitch(seg, 'DISABLE');
        },
      },
      sql,
      state.mode,
      'user',
    );
    return json(200, { fired: level });
  }

  // Webhooks from Upstox
  if (url.pathname === '/hooks/order' || url.pathname === '/hooks/token') {
    void audit(sql, {
      kind: 'WEBHOOK_HINT',
      actor: 'webhook',
      mode: state.mode,
      payload: { path: url.pathname, trusted: false },
    });
    return json(200, { accepted: true, action: 'queued_for_repoll' });
  }

  return json(404, { error: 'not found' });
});

async function main(): Promise<void> {
  console.log(`TradeForger engine booting — mode ${cfg.TF_MODE}, strategy ${cfg.TF_AUTO_TRADING_MODE}, IST ${istHHMM(clock.now())}`);

  await audit(sql, {
    kind: 'ENGINE_BOOT',
    actor: 'engine',
    mode: cfg.TF_MODE,
    payload: {
      version: '0.2.0',
      sizingMode: cfg.TF_SIZING_MODE,
      strategyMode: cfg.TF_AUTO_TRADING_MODE,
    },
  });

  const pf = await preflight(sql, client, clock, { requireTrading: cfg.TF_MODE === 'LIVE' });
  for (const c of pf.checks) {
    console.log(`  ${c.passed ? '✓' : c.hard ? '✗' : '·'} ${c.name.padEnd(20)} ${c.detail}`);
  }

  if (!pf.passed) {
    console.warn('Preflight warning/failures detected — defaulting to PAPER broker safety');
    state.mode = 'PAPER';
    activeBroker = paperBroker;
  }

  // Warmup candles seed
  await seedWarmupCandles();

  // Connect live Upstox V3 Market Feed
  try {
    await feed.connect();
  } catch (err) {
    console.error('[feed connect failed]', err);
  }

  server.listen(cfg.TF_ENGINE_PORT, '127.0.0.1', () => {
    console.log(`✓ TradeForger Control API running on http://127.0.0.1:${cfg.TF_ENGINE_PORT}`);
    console.log(`✓ Active Profiles: Intraday (${strategyManager.getMode()})`);
    console.log(`✓ AI Analysis Model: Free Real-time Quantitative Engine + ${cfg.GROQ_API_KEY ? cfg.GROQ_MODEL : 'Local Zero-Cost Mode'}`);
    console.log(`✓ Subscribed Universe: ${watchlist.size} liquid NSE stocks`);
  });
}

const shutdown = async (sig: string): Promise<void> => {
  console.log(`\n${sig} — shutting down gracefully`);
  await audit(sql, { kind: 'ENGINE_SHUTDOWN', actor: 'engine', mode: state.mode, payload: { sig } });
  feed.close();
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
