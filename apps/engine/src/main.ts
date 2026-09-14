import { createServer } from 'node:http';
import { SystemClock, istHHMM, formatINR, type Paise } from '@tradeforger/core';
import { db, audit, closeDb } from '@tradeforger/db';
import { TokenStore, UpstoxClient } from '@tradeforger/upstox';
import { PaperBroker } from '@tradeforger/broker';
import { evaluate, effectiveMode, fire, type RiskSnapshot } from '@tradeforger/safety';
import { MarketFeed } from '@tradeforger/feed';
import { Confirmer, DEFAULT_AI_CONFIG } from '@tradeforger/ai';
import { IntradayProfile } from '@tradeforger/strategy';
import { loadConfig } from './config.ts';
import { preflight } from './preflight.ts';

const clock = SystemClock;
const cfg = loadConfig();
const sql = db(cfg.DATABASE_URL);

const tokens = new TokenStore(clock, {
  ...(cfg.UPSTOX_ANALYTICS_TOKEN ? { analyticsToken: cfg.UPSTOX_ANALYTICS_TOKEN } : {}),
});

const client = new UpstoxClient(tokens, {
  clock,
  onHalt: (e) => {
    // STATIC_IP_REQUIRED or TOKEN_INVALID: every subsequent trading call will
    // fail identically, so stop rather than burn the reject-rate breaker.
    console.error(`[HALT] ${e.kind}: ${e.message}`);
    state.manualHalt = true;
  },
});

// PAPER is the only broker wired in this build. SANDBOX and LIVE ports exist as
// interfaces; they are deliberately not constructible until the validation
// ladder in docs/00-PLAN.md §7 has been walked.
const broker = new PaperBroker(clock);
const strategy = new IntradayProfile();
const confirmer = cfg.GROQ_API_KEY
  ? new Confirmer({
      ...DEFAULT_AI_CONFIG,
      apiKey: cfg.GROQ_API_KEY,
      model: cfg.GROQ_MODEL,
      baseUrl: cfg.GROQ_BASE_URL,
    })
  : null;

const state = {
  mode: cfg.TF_MODE,
  manualHalt: false,
  startedAt: clock.ms(),
  ticks: 0,
  lastTickMs: null as number | null,
  signals: 0,
  orders: [] as number[],
};

function snapshot(): RiskSnapshot {
  return {
    startingCapitalPaise: (cfg.TF_MAX_DEPLOYED_CAPITAL * 100) as Paise,
    realisedPnlPaise: 0 as Paise,
    unrealisedPnlPaise: 0 as Paise,
    openPositions: 0,
    ordersToday: state.orders.length,
    consecutiveLosses: 0,
    rejectsLast5Min: 0,
    orderTimestamps: state.orders,
    lastTickMs: state.lastTickMs,
    marginUtilisationPct: 0,
    divergenceDetected: false,
    manualHalt: state.manualHalt,
    worstOpenLossPaise: 0 as Paise,
  };
}

const feed = new MarketFeed(async () => {
  const r = await client.marketFeedUrl();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}, clock);

feed.on('tick', (t) => {
  state.ticks++;
  state.lastTickMs = clock.ms();
  broker.onTick(t);
});
feed.on('error', (e) => console.error('[feed]', e.message));
feed.on('open', () => console.log('[feed] connected'));
feed.on('close', (c, r) => console.warn(`[feed] closed ${c} ${r}`));

/**
 * Local control API, bound to loopback.
 *
 * The Vercel control plane reaches this through a Cloudflare Tunnel; it is
 * never exposed directly. Every route requires the shared engine token.
 */
const server = createServer((req, res) => {
  const auth = req.headers.authorization;
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (url.pathname === '/health') {
    const verdict = evaluate(snapshot(), cfg.limits, clock);
    return json(200, {
      ok: true,
      mode: effectiveMode({ mode: state.mode, armedUntilMs: null, armedBy: null }, clock),
      istTime: istHHMM(clock.now()),
      uptimeMs: clock.ms() - state.startedAt,
      ticks: state.ticks,
      feedStaleness: feed.staleness(),
      subscribed: feed.subscribedCount,
      allowEntries: verdict.allowEntries,
      allowExits: verdict.allowExits,
      trips: verdict.trips.map((t) => t.id),
      limits: {
        maxSpendPerTrade: formatINR(cfg.limits.maxSpendPerTradePaise),
        maxDeployed: formatINR(cfg.limits.maxDeployedCapitalPaise),
      },
    });
  }

  if (auth !== `Bearer ${cfg.TF_ENGINE_TOKEN}`) return json(401, { error: 'unauthorized' });

  if (url.pathname === '/hooks/order' || url.pathname === '/hooks/token') {
    // Webhook payloads are UNTRUSTED hints — Upstox does not sign them. They
    // only trigger an authenticated re-poll; they never mutate state directly.
    void audit(sql, {
      kind: 'WEBHOOK_HINT', actor: 'webhook', mode: state.mode,
      payload: { path: url.pathname, trusted: false },
    });
    return json(200, { accepted: true, action: 'queued_for_repoll' });
  }

  if (url.pathname === '/kill' && req.method === 'POST') {
    const level = (url.searchParams.get('level') ?? 'SOFT') as 'SOFT' | 'HARD' | 'NUCLEAR';
    void fire(level, {
      stopNewEntries: async () => { state.manualHalt = true; },
      cancelAllOpenOrders: async () => 0,
      cancelAllGtt: async () => 0,
      exitAllPositions: async () => {
        const r = await broker.exitAllPositions();
        return r.ok ? r.value : 0;
      },
      disableSegment: async (seg) => { await client.killSwitch(seg, 'DISABLE'); },
    }, sql, state.mode, 'user');
    return json(200, { fired: level });
  }

  return json(404, { error: 'not found' });
});

async function main(): Promise<void> {
  console.log(`TradeForger engine — mode ${cfg.TF_MODE}, IST ${istHHMM(clock.now())}`);

  await audit(sql, {
    kind: 'ENGINE_BOOT', actor: 'engine', mode: cfg.TF_MODE,
    payload: { version: '0.1.0', sizingMode: cfg.TF_SIZING_MODE },
  });

  const pf = await preflight(sql, client, clock, { requireTrading: cfg.TF_MODE === 'LIVE' });
  for (const c of pf.checks) {
    console.log(`  ${c.passed ? '✓' : c.hard ? '✗' : '·'} ${c.name.padEnd(20)} ${c.detail}`);
  }
  await audit(sql, {
    kind: pf.passed ? 'PREFLIGHT_PASS' : 'PREFLIGHT_FAIL',
    actor: 'engine', mode: cfg.TF_MODE,
    payload: { checks: pf.checks.map((c) => ({ ...c })) },
  });

  if (!pf.passed) {
    console.error('preflight failed — forcing PAPER');
    state.mode = 'PAPER';
  }

  await feed.connect();
  server.listen(cfg.TF_ENGINE_PORT, '127.0.0.1', () => {
    console.log(`control API on http://127.0.0.1:${cfg.TF_ENGINE_PORT}`);
    console.log(`strategy: ${strategy.name} (warmup ${strategy.warmupBars} bars)`);
    console.log(`AI: ${confirmer ? cfg.GROQ_MODEL : 'disabled'}`);
  });
}

const shutdown = async (sig: string): Promise<void> => {
  console.log(`\n${sig} — shutting down`);
  await audit(sql, { kind: 'ENGINE_SHUTDOWN', actor: 'engine', mode: state.mode, payload: { sig } });
  feed.close();
  server.close();
  await closeDb();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch(async (e: unknown) => {
  console.error('engine failed to start:', e);
  await closeDb();
  process.exit(1);
});
