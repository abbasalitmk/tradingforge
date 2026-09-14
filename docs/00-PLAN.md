# TradeForger — Autonomous Trading System
## Architecture & Build Plan (v1)

Personal, single-account autonomous equity trading on Upstox.
Author: abba · Account: `4NC6KA` · Plan date: 2026-09-14

---

## 0. Findings that change the original brief

Research against the live Upstox OpenAPI spec (`https://api.upstox.com/v2/api-docs`, 96 endpoints)
and the developer docs produced five corrections. These are load-bearing — the design below
depends on them.

### 0.1 Upstox now HAS native OCO/bracket orders — `GTT MULTIPLE`
The brief assumed no OCO and specified a self-managed watcher that places two GTTs and cancels
the sibling on fill. That is obsolete. `POST /v3/order/gtt/place` accepts:

```
type: SINGLE | MULTIPLE
rules: [
  { strategy: ENTRY,    trigger_type: ABOVE|BELOW|IMMEDIATE, trigger_price },
  { strategy: TARGET,   trigger_type: IMMEDIATE,             trigger_price },
  { strategy: STOPLOSS, trigger_type: IMMEDIATE,             trigger_price,
    trailing_gap, market_protection }
]
```

`MULTIPLE` = entry + target + stoploss as one exchange-side bracket, with **server-side trailing
stop** (`trailing_gap`). Sibling cancellation is handled by Upstox.

**Impact:** the SL/target watcher stops being the primary exit mechanism and becomes a
*reconciliation backstop*. Exits survive our process dying — a materially safer system.
`market_protection` (-1 auto, 0 none, 1–25 %) caps slippage on the market-exit leg.

### 0.2 Order fills arrive over WebSocket — no public webhook needed
`wss://api.upstox.com/v2/feed/portfolio-stream-feed` with
`update_types=order,gtt_order,position,holding` streams **JSON** (not protobuf) order updates,
including fills placed from any platform. The brief's webhook design requires a public HTTPS
endpoint; this does not. For a personal system this removes an entire class of deployment pain.

**Impact:** webhooks become optional redundancy, not the source of truth.

### 0.3 The Upstox sandbox is nearly useless as a test bed
Sandbox covers **7 endpoints only** — place/modify/cancel order (v2 + v3) and place multi-order.
No market data, no funds, no positions, no GTT, no historical candles. Token valid 30 days.

**Impact:** "sandbox-by-default" as written cannot exercise the strategy loop. The real test bed
must be an **internal paper broker** — a deterministic fill simulator driven by the live V3 tick
feed, modelling slippage, partial fills, and queue position. Upstox sandbox is demoted to a
contract-conformance test for the order payloads. This is the single biggest change to the plan
and it is non-optional: you cannot validate an autonomous system on an environment that can't
tell you the price.

### 0.4 Account APIs require a static IP allowlist — verified live
Probing the supplied Analytics Token:

| Endpoint | Result |
|---|---|
| `/v3/market-quote/ltp` | ✅ 200 |
| `/v3/historical-candle/…` | ✅ 200 |
| `/v2/instruments/search` | ✅ 200 |
| `/v3/feed/market-data-feed/authorize` | ✅ 200 |
| `/v2/user/profile` | ❌ 401 `UDAPI1221` |
| `/v3/user/get-funds-and-margin` | ❌ 401 `UDAPI1221` |
| `/v2/portfolio/short-term-positions` | ❌ 401 `UDAPI1221` |
| `/v2/order/retrieve-all` | ❌ 401 `UDAPI1221` |
| `/v2/user/kill-switch` | ❌ 401 `UDAPI1221` |

> `UDAPI1221`: *"permitted only when requested from the static IP configured in your account"*

**Impact:** a clean plane split falls out of this, and a hard deployment constraint.
- **Data plane** — market quotes, candles, instruments, market feed. Analytics token, valid to
  **2027-09-14**, no daily refresh, no IP restriction, runs anywhere.
- **Trading plane** — funds, positions, orders, kill switch. Daily OAuth token, **must originate
  from an allowlisted static IP**.

The system must therefore either run on a static-IP host, or self-manage the allowlist via
`GET/PUT /v2/user/ip` on startup. Both are designed for below (§6.3).

### 0.5 The "Grok" key is a **Groq** key, not xAI
`gsk_…` is Groq Cloud. Verified live — the key works and exposes:
`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `groq/compound`, `groq/compound-mini`,
`qwen/qwen3.8-27b`, `qwen/qwen3.6-27b`, `allam-2-7b`.

No xAI endpoint or model is reachable with it. Groq is a better fit anyway — sub-second inference
matters when a scalping signal has a 30-second shelf life, where xAI's API would not keep up.
Default: **`openai/gpt-oss-120b`** for confirmation, `groq/compound-mini` for cheap bulk
scanner annotation. The interface is OpenAI-compatible either way, so swapping providers later
is a base-URL change.

---

## 1. Credential hygiene — do this before anything else

The API secret, access token and Groq key were pasted in plaintext into a chat transcript.
Treat all three as compromised.

1. **Rotate the API secret** (`wnom4e98ol`) at https://account.upstox.com/developer/apps.
2. **Rotate the Groq key** at https://console.groq.com/keys.
3. The Analytics Token (`…DIKcorbn`) is read-only and IP-locked, so exposure is low-risk — but
   regenerate it with the others.
4. `stockwatch` has the same problem and is deployed to Vercel: `src/services/upstox.js:7-8`
   hardcodes a key/secret, `src/services/groq.js:2` hardcodes a Groq key, and `set-token.js`
   contains a live access token. Rotate those too, and purge them from git history.

TradeForger takes **zero** secrets in source. Everything through `.env.local`, validated by a Zod
schema at boot; the process refuses to start on a missing or malformed variable.

---

## 2. What we inherit from `stockwatch`

~14,000 lines, and the analytics core is genuinely reusable. Port it to TypeScript with tests
rather than rewriting:

| Source | Lines | Disposition |
|---|---|---|
| `utils/indicators.js` | 1,216 | **Port.** 30 indicators — EMA/SMA/WMA, RSI, MACD, VWAP, ATR, Bollinger, Stochastic, ADX, OBV, MFI, Williams %R, **SuperTrend**, Keltner, BB-squeeze, CPR, pivots, Ichimoku, Fibonacci, RS, ROC, A/D, divergence & crossover detection. Covers every indicator the brief asks for. |
| `utils/professionalFilters.js` | 1,445 | **Port selectively.** ORB, VWAP position, volume algo, breakout engine, institutional-activity detection, smart-money concepts, market structure, EMA21 reversal. This is the scanner core. |
| `utils/swingStrategies.js` | 692 | **Port.** Trend-following, mean-reversion, breakout, support-reversal, multi-timeframe. Maps to the Swing profile. |
| `utils/scoring.js` | 698 | **Port, then re-derive thresholds from backtests.** Hand-tuned weights must not be trusted blind in an autonomous loop. |
| `utils/candlestick.js` + `patterns.js` | 670 | **Port.** Single/double/triple-candle patterns + confluence. |
| `utils/qualityFilters.js` | 431 | **Port.** Liquidity, volatility, momentum-quality ranking. |
| `utils/advancedAnalysis.js` | 729 | **Merge** into the above — overlaps heavily. |
| `services/upstox.js` | 994 | **Rewrite.** Browser-side, hardcoded creds, no rate limiting, localStorage tokens, mock-data fallbacks that silently fabricate prices. All disqualifying for live trading. |
| `services/websocket.js` | 258 | **Rewrite.** Never decodes protobuf — it tries `JSON.parse` on a binary frame, so it has never actually worked against V3. |
| `services/groq.js` | 455 | **Rewrite** as a structured-output confirmation layer with a strict schema. |
| React components | ~4,000 | **Reference only.** New UI on Next.js server components. |

The mock-data fallback in `getMarketQuote()` deserves a specific callout: on auth failure it
returns *invented* prices. In an analytics tool that is a cosmetic bug. In an autonomous trader it
places real orders against fictional prices. The new client fails closed, always.

---

## 3. Architecture

```
                        ┌──────────────────────────────────────────┐
                        │            CONTROL PLANE                 │
                        │  Next.js 15 (App Router) · port 3000     │
                        │  Dashboard · Scanner · Journal · Kill     │
                        └───────┬──────────────────────▲───────────┘
                                │ commands (HTTP)      │ SSE
                                ▼                      │
   ┌────────────────────────────────────────────────────────────────┐
   │                      ENGINE  (single Node process)             │
   │                                                                │
   │  ┌──────────────┐   ticks   ┌──────────────┐  signals          │
   │  │ Feed Ingestor├──────────►│ Strategy Eng ├────────┐          │
   │  │ WS V3 proto  │           │ scalp/intra/ │        │          │
   │  └──────────────┘           │ swing        │        ▼          │
   │  ┌──────────────┐           └──────────────┘  ┌──────────────┐ │
   │  │ Portfolio WS │──fills──────────────────────►│ Risk Engine │ │
   │  │ order/pos    │                              │ sizing·gates│ │
   │  └──────────────┘                              └──────┬──────┘ │
   │  ┌──────────────┐                                     ▼        │
   │  │ AI Confirmer │◄────────────────────────────┬──────────────┐ │
   │  │ Groq         │                             │ Execution SM │ │
   │  └──────────────┘                             └──────┬───────┘ │
   │  ┌──────────────────────────────────────────────────┐│         │
   │  │ SUPERVISOR: kill switch · circuit breakers ·      ││         │
   │  │ heartbeat · reconciler · EOD squareoff            ││         │
   │  └──────────────────────────────────────────────────┘│         │
   └───────────────────────────────────────────────────────┼─────────┘
                                                           ▼
                         ┌───────────────────────────────────────┐
                         │           BROKER PORT                 │
                         │  Paper │ UpstoxSandbox │ UpstoxLive   │
                         └───────────────────────────────────────┘
                                          │
                   Postgres 17 (TimescaleDB) ·  Redis 8
```

### 3.1 Deliberate deviations from the brief

**One engine process, not BullMQ workers.** The brief specifies BullMQ. For a single-account
system this is the wrong trade: queue hops add latency to the tick→order path and, worse, make
*ordering* non-deterministic — two workers can both see "flat" and both open a position. A single
supervised process with in-memory state and an explicit event loop is faster, race-free, and far
easier to reason about at 3am when something has gone wrong. Postgres remains the durable
journal; Redis holds hot state. BullMQ stays available for genuinely async off-path work
(backtests, EOD reports) where latency and ordering don't matter.

**Position state is owned by exactly one module.** The execution state machine. Nothing else
writes it. Every transition is persisted before the side effect, so a crash mid-order is
recoverable by replaying the journal against the broker's order book.

**The engine is crash-only.** No graceful-shutdown assumptions. On boot it reconciles local state
against `/v2/order/retrieve-all`, `/v2/portfolio/short-term-positions` and `/v3/order/gtt`, and
refuses to trade until they agree.

### 3.2 Stack

| Layer | Choice | Note |
|---|---|---|
| Runtime | Node 23 (installed) + TypeScript strict | |
| Web | Next.js 15 App Router | control plane only |
| Engine | standalone `tsx` process, pm2/launchd supervised | |
| DB | **Postgres 17** — running locally | + TimescaleDB for candles/ticks |
| Cache | **Redis 8** — running locally | LTP, token buckets, hot position state |
| Transport | Redis pub/sub → SSE to browser | |
| Upstox | hand-rolled typed client over `undici` | `upstox-js-sdk@2.31.0` is untyped, wraps v2 only, and hides rate-limit control we need |
| Protobuf | `protobufjs` + official `MarketDataFeed.proto` | |
| Charts | `lightweight-charts` v5 | already known from stockwatch |
| AI | Groq, OpenAI-compatible, structured outputs | |
| Migrations | Drizzle | |
| Tests | Vitest + a deterministic market simulator | |

---

## 4. Safety layer — built first, cannot be bypassed

Every one of these is enforced **inside** the broker port, below the strategy layer. A strategy
bug, an LLM hallucination or a bad manual click cannot route around them.

### 4.1 Mode ladder
```
PAPER  →  SANDBOX  →  LIVE_ARMED  →  LIVE
```
- `PAPER` (default): internal fill simulator. No Upstox order calls. Ever.
- `SANDBOX`: Upstox sandbox order endpoints. Payload conformance only.
- `LIVE_ARMED`: live credentials loaded, orders **blocked**. Dry-run logging of exact payloads.
- `LIVE`: real money. Requires **all** of: `LIVE_TRADING=true` in env, a typed confirmation
  phrase in the UI, a non-expired daily token, a passing preflight (§4.6), and an explicit
  per-session arm that **auto-expires at 15:30 IST**.

Downgrade is always instant and unconditional. Upgrade is never automatic.

### 4.2 Circuit breakers
Evaluated before every order and on every tick. Any trip → `HALTED`, requiring manual reset.

| Breaker | Default | Action |
|---|---|---|
| Daily realised+unrealised loss | 2% of capital | halt new entries, keep exits |
| Per-trade loss | 1% of capital | force-exit that position |
| Consecutive losses | 3 | halt for the session |
| Max concurrent positions | 3 | reject new entries |
| Max orders/day | 40 | halt (runaway-loop guard) |
| Max orders/minute | 6 | halt — an autonomous system placing >6/min is malfunctioning |
| Order-reject rate | 3 rejects in 5 min | halt |
| Feed staleness | no tick 10s in market hours | halt entries, hold exits |
| Engine↔broker divergence | any | halt immediately |
| Margin utilisation | 80% | reject new entries |

The orders/minute and orders/day breakers are the runaway guards. The rate limit is 10/s — a
looping bug would burn the daily loss limit in seconds without them.

### 4.3 Kill switch — three levels
1. **Soft** — stop new entries, keep managing open positions. One click.
2. **Hard** — cancel all open orders, cancel all GTTs, `POST /v2/order/positions/exit`, flatten.
3. **Nuclear** — hard, then `POST /v2/user/kill-switch {segment:"NSE_EQ", action:"DISABLE"}`,
   disabling the segment at Upstox account level. Survives our process being compromised.
   Note: re-enabling is subject to Upstox's own cooldown — nuclear is genuinely a last resort.

Reachable from the UI, a CLI (`pnpm kill`), and a local HTTP endpoint bound to loopback.

### 4.4 Dead-man's switch
The engine writes a heartbeat to Redis every second. A separate tiny watchdog process — which
shares no code with the engine — flattens everything if the heartbeat goes stale for 30s during
market hours. This covers the case the kill switch cannot: the engine itself hanging with
positions open.

### 4.5 Hard time rules
- No new entries before **09:20 IST** (skip the opening auction's noise) or after **14:45**.
- Intraday/scalp force-square-off at **15:10**, unconditional, market orders.
- No orders during the Upstox maintenance window **00:00–05:30 IST** (funds API returns 423).
- Market-holiday check against `/v2/market/holidays` at boot and at 09:00 daily.

### 4.6 Preflight (runs at 09:00 IST and before any arm)
Token valid · static IP allowlisted · funds fetched and non-zero · positions reconciled ·
no orphan GTTs · both WS feeds connected and receiving · instrument master ≤24h old ·
circuit breakers reset · clock drift <1s (NTP).
Any failure ⇒ mode drops to `PAPER`.

### 4.7 Audit log
Append-only Postgres table, `hash` chained to the previous row (tamper-evident). Records every
tick-driven decision, signal, LLM prompt+response, risk verdict, order payload, broker response
and state transition, with an idempotency key. No `UPDATE` or `DELETE` grant on the table for the
application role.

### 4.8 Regulatory posture
SEBI's algo framework (NSE circular 05-May-2025) distinguishes retail algos by registration.
We throttle to **Regular Algo** limits — 10/s, 500/min, 2000/30min — via a single shared token
bucket across place/modify/cancel/multi/GTT, never four separate ones. A per-strategy daily order
budget sits under that. The UI carries a permanent, non-dismissible disclaimer.

---

## 5. Data plane

### 5.1 Instrument master
`complete.json.gz` / `NSE.json.gz` pulled daily at 06:30 IST into Postgres. `stockwatch` already
has `NSE.json.gz` — reuse as the seed. Never call `/instruments/search` per symbol for a scan.

### 5.2 Candles — V3 limits drive the fetch planner
| Unit | Intervals | History from | Max span/request |
|---|---|---|---|
| `minutes` | 1–300 | Jan 2022 | 1 month (≤15m) · 1 quarter (>15m) |
| `hours` | 1–5 | Jan 2022 | 1 quarter |
| `days` | 1 | Jan 2000 | 1 decade |
| `weeks` / `months` | 1 | Jan 2000 | unlimited |

The backfill job chunks requests to these bounds, respects 50/s standard-API limits, and stores
into a TimescaleDB hypertable. Live candles are built from ticks and **cross-checked** against
the REST candle on close — divergence >0.1% raises an alert.

### 5.3 Tick feed
V3 protobuf WS, `full` mode for the active watchlist + open positions, `ltpc` for the wider
scanner universe. Standard-tier limits: **2 connections/user**, 2000 instruments `full`,
5000 `ltpc`. We have exactly two connections and need both (market + portfolio) — so the engine
owns both, and the web app never opens one. Aggressive unsubscribe as the watchlist rotates.

### 5.4 Scanner
Two-stage, to stay inside the instrument budget:
1. **Coarse** — whole NSE equity universe on daily candles + batch LTP (`/v3/market-quote/ltp`,
   500 keys/call). Liquidity floor, price band, ATR band, gap, RVOL. Runs 08:45 and hourly.
   Output: ~150 candidates.
2. **Fine** — those 150 subscribed `full` on the WS feed, full indicator stack per tick-close,
   professional filters, ranked. This is the live scanner table.

---

## 6. Strategy, risk & execution

### 6.1 Profiles
| | Scalping | Intraday | Swing |
|---|---|---|---|
| Candles | 1m / 3m | 5m / 15m | 1d / 1w |
| Entry | VWAP + EMA9/21 cross, volume spike, micro-breakout | ORB(15m), SuperTrend, VWAP reclaim, RSI(14) confirm | EMA20/50 trend, MACD, RSI divergence, S/R |
| Hold | seconds–minutes | minutes–hours | days–weeks |
| SL | ATR×1.0 | ATR×1.5 | ATR×2.5 |
| Target | 1:1.2 | 1:2 | 1:3, partial at 1:1.5 |
| Trailing | on every favourable tick | after 1R | daily-close only |
| Product | `I` | `I` | `D` |
| Max/day | 10 | 5 | 2 |
| Time exit | 5 min no-move | 15:10 | none |

Each profile is a module implementing one interface, so a profile is added without touching the
engine. **v1 ships Intraday equity only** (decided 2026-09-14). Scalping and Swing modules are
scaffolded against the same interface but are not wired into the live loop until Intraday has
cleared the full validation ladder (§7). Concurrent profiles compete for the same capital and
the interaction is hard to reason about before each is individually validated.

### 6.2 Position sizing — three user-selectable modes

Sizing is a **user setting, not a strategy decision**. The UI exposes three modes; the strategy
proposes entry/stop/target and the sizer decides quantity.

| Mode | Input | Quantity |
|---|---|---|
| `FIXED_QTY` | "buy 25 shares" | exactly 25, subject to caps |
| `FIXED_BUDGET` | "spend at most ₹50,000" | `floor(budget / entry_price)` |
| `RISK_BASED` | "risk 1% of capital" | `floor(risk_amount / (entry − stop))` |

All three then pass through the same hard caps, and the **lowest wins**:

```
qty = min(
   mode_qty,                         ← from the table above
   max_position_value / entry,       ← concentration cap
   0.01 × avg_daily_volume,          ← liquidity cap (our own, not Upstox's)
   margin_available / margin_per_unit,
   budget_ceiling / entry            ← absolute per-trade spend ceiling, always enforced
)
```

Then floored to lot size. Rejected entirely if `qty < 1`, or if `qty × entry` is below a minimum
viable ticket where round-trip brokerage + STT would exceed a meaningful fraction of the target.

Two ceilings are always active regardless of mode, and are set once in settings rather than
per-trade: **max spend per trade** and **max total deployed capital**. `FIXED_QTY` is the mode
that most needs them — a fixed 25 shares is a very different rupee exposure on a ₹100 stock than
on a ₹3,000 one, and without a rupee ceiling a fat-finger entry sizes straight into the whole
account.

`FIXED_BUDGET` is the default, since it is what "buy only that quantity within this price limit"
means directly, and it behaves sanely across the whole price spectrum.

Stop-loss distance still comes from ATR in every mode — sizing mode changes *how many*, never
*where the stop goes*. The daily-loss circuit breaker (§4.2) is expressed in rupees and is
independent of sizing mode, so it remains the real backstop.

### 6.2b Pre-trade gate

In order — cheapest and most likely to reject, first:
mode allows live → circuit breakers clear → time window open → not already in this symbol →
concurrent-position cap → daily order budget → sizing produces `qty ≥ 1` → spend ceilings →
funds check (`/v3/user/get-funds-and-margin`, cached 5s) → margin check
(`POST /v2/charges/margin`) → liquidity sanity (spread <0.3%, LTP within 2% of last candle
close) → rate-limit token available.

### 6.3 Static IP handling
On boot the engine resolves its egress IP, compares against `GET /v2/user/ip`, and if it differs
either self-updates via `PUT /v2/user/ip` (if enabled) or halts with a clear error. Running on a
dynamic-IP home connection without this will fail every trading call with `UDAPI1221` — worth
knowing before market open rather than at 09:15.

### 6.4 Execution state machine
```
IDLE → CANDIDATE → AI_REVIEWED → RISK_APPROVED → ENTRY_SENT
  → ENTRY_ACKED → ENTRY_FILLED → BRACKET_ARMED → MANAGING
  → EXIT_TRIGGERED → EXIT_FILLED → CLOSED
             ↘ REJECTED   ↘ CANCELLED   ↘ ORPHANED(→ manual)
```
- Entry: `POST /v3/order/place`, `tag` = internal position ULID (idempotency).
- On confirmed fill (portfolio WS): `POST /v3/order/gtt/place` `type=MULTIPLE` with TARGET +
  STOPLOSS(+`trailing_gap`) legs. Exchange-side bracket — survives our process dying.
- `MANAGING`: reconcile against the GTT every 5s. The watcher's job is detecting *divergence*,
  not driving exits.
- `ORPHANED` — position exists with no live bracket — is a **hard halt**. It is the single most
  dangerous state in the system and never auto-resolves.
- Every transition persisted **before** the side effect it causes.

### 6.5 AI layer
The LLM is advisory and **can only ever reduce risk**. Contract:
- Input: structured JSON — symbol, profile, indicator values, pattern hits, proposed entry/SL/
  target, computed size, recent candles. Never free text.
- Output: strict JSON schema — `{ verdict: CONFIRM|REJECT|CAUTION, confidence: 0-100,
  risk_flags: string[], rationale: string }`. Schema-validated; malformed ⇒ discarded.
- Gate: `REJECT` blocks the trade. `CAUTION` halves size. `CONFIRM` changes nothing — it cannot
  increase size, loosen a stop, or override a breaker.
- 800ms timeout. On timeout/error/rate-limit, fall through to indicator-only. The system must
  trade correctly with the AI entirely offline.
- Prompt + response + latency + model id logged against the signal.

This asymmetry is the point: an LLM failure can cost missed trades, never unbounded loss.

---

## 7. Validation gates — no phase skipped

1. **Unit** — every indicator against known-good fixtures from TradingView.
2. **Replay** — engine runs against recorded tick data at 1×/100×; deterministic, same input ⇒
   same orders. This is the regression suite.
3. **Backtest** — ≥2 years daily, ≥6 months intraday. Report CAGR, max drawdown, Sharpe, win
   rate, profit factor, expectancy, and cost-adjusted P&L (brokerage + STT + stamp + slippage —
   `/v2/charges/brokerage` gives real numbers). Walk-forward, not a single in-sample fit.
4. **Paper** — ≥20 live sessions. Promotion requires positive expectancy *after costs*, max
   drawdown inside limits, zero `ORPHANED` events, zero unexplained divergences.
5. **Live micro** — ₹5,000 capital, 1 position, 10 sessions. Reconcile every fill by hand
   against the Upstox app.
6. **Live scaled** — increase only after a profitable micro period.

Gate 4→5 is where most systems quietly fail. The metric that matters is expectancy after costs;
a strategy with a 65% win rate and negative expectancy is common and ruinous.

---

## 8. Build phases

| # | Phase | Deliverable | Est. |
|---|---|---|---|
| 0 | Foundation | Monorepo, TS strict, env schema, Postgres+Redis, Drizzle migrations, audit log, structured logging | 1d |
| 1 | Safety | Mode ladder, circuit breakers, kill switch (3 levels), dead-man's switch, preflight — with tests, before any order code exists | 1.5d |
| 2 | Upstox client | Typed client for all 96 endpoints we use, shared token bucket, retry/backoff, token lifecycle + daily re-auth, static-IP manager | 2d |
| 3 | Broker port | `Paper` (fill simulator w/ slippage + partials), `UpstoxSandbox`, `UpstoxLive`. Identical interface, mode-gated | 1.5d |
| 4 | Data plane | Instrument sync, candle backfill w/ chunk planner, protobuf V3 feed, portfolio feed, Redis relay, TimescaleDB | 2.5d |
| 5 | Indicators | Port stockwatch → typed + tested. 30 indicators, patterns, filters | 2d |
| 6 | Strategy | Three profiles, signal generation, replay harness | 2.5d |
| 7 | Risk + execution | Sizing, pre-trade gate, state machine, GTT bracket, reconciler, EOD squareoff | 2.5d |
| 8 | Backtest | Walk-forward engine, cost model, metrics report | 2d |
| 9 | AI layer | Groq confirmer, schema validation, fallback, logging | 1d |
| 10 | UI | Dashboard, scanner, chart w/ overlays, positions, journal, kill switch, disclaimer | 3d |
| 11 | Hardening | Chaos tests (feed drop, token expiry mid-trade, partial fill, reject storm, process kill w/ open position), runbook | 2d |

~23 working days. Phases 0–3 are the ones that must not be rushed; everything after is
recoverable, and a mistake in 0–3 is not.

---

## 9. Repo layout

```
tradeforger/
├─ apps/
│  ├─ web/                  Next.js 15 control plane
│  ├─ engine/               trading engine (single process)
│  └─ watchdog/             dead-man's switch (no shared code, by design)
├─ packages/
│  ├─ core/                 domain types, ULIDs, clock, Result<T,E>
│  ├─ upstox/               typed client, rate limiter, tokens, protobuf feed
│  ├─ broker/               BrokerPort + Paper|Sandbox|Live
│  ├─ indicators/           ported from stockwatch, typed + tested
│  ├─ strategy/             profiles + signal generation
│  ├─ risk/                 sizing, breakers, gates
│  ├─ ai/                   Groq confirmer
│  ├─ backtest/             replay + walk-forward + cost model
│  └─ db/                   Drizzle schema + migrations
├─ docs/                    this plan, runbook, API notes
└─ scripts/                 kill, preflight, backfill, rotate-token
```

---

## 10. Known risks

| Risk | Mitigation |
|---|---|
| Strategy has no real edge | Gate 3+4 measure expectancy after costs, not win rate. Accept the possibility the honest answer is "don't trade this." |
| Dynamic home IP breaks trading calls | §6.3 static-IP manager; preflight catches it at 09:00, not 09:15 |
| Token expires 03:30 IST mid-automation | Daily re-auth scheduler + preflight; `LIVE` arm auto-expires each session |
| Process dies holding a position | GTT bracket is exchange-side; watchdog flattens on stale heartbeat |
| Feed gap → stale prices → bad entries | Staleness breaker at 10s; entries halt, exits continue |
| Partial fills desync state | State machine models partials explicitly; reconciler is authoritative |
| Runaway order loop | orders/min + orders/day breakers, shared token bucket |
| LLM hallucination | AI can only reduce risk; never sizes up or overrides |
| Overfitting to backtest | Walk-forward, out-of-sample holdout, paper gate |
| SEBI algo registration | Throttled to Regular Algo limits; revisit if frequency rises |

---

## 11. Decisions taken (2026-09-14)

| # | Decision |
|---|---|
| Scope | **Intraday equity only** for v1. Scalping/Swing scaffolded, not live. |
| Sizing | **User-selectable**: `FIXED_QTY`, `FIXED_BUDGET` (default), `RISK_BASED` — see §6.2. Absolute rupee ceilings always enforced. |
| Capital | Not a fixed constant. Derived from live funds + the user's configured ceilings. |
| Live gating | **Full ladder** (§7), enforced in code. `LIVE` unreachable until paper sessions show positive expectancy after costs. |
| Hosting | Split — see §12. Vercel for UI only. |

---

## 12. Deployment topology

The user's stated preference was to host on Vercel. **The engine cannot run there**, for three
structural reasons:

1. Vercel functions are request-scoped with a hard duration cap. The V3 market feed needs a
   WebSocket held open continuously for the 6.5-hour session.
2. There is no background process. Nothing can watch an open position between HTTP requests,
   which is the entire job of the execution state machine.
3. Vercel egress comes from a rotating IP pool, so every trading-plane call returns
   `401 UDAPI1221` (§0.4). This one is fatal on its own and cannot be worked around from
   inside Vercel on a Hobby/Pro plan.

This costs nothing architecturally, because the design already forbids the web app from calling
Upstox directly. The split:

```
   Browser
      │  https
      ▼
  ┌───────────────┐      Cloudflare Tunnel        ┌─────────────────────┐
  │  Next.js (UI)   │ ─── mTLS / signed JWT ───► │  ENGINE              │
  │  VERCEL         │ ◄── SSE: ticks, P&L, state ─ │  static IP host      │
  │  stateless      │                             │  Postgres + Redis    │
  └───────────────┘                             └────────┬───────────┘
                                                            │ allowlisted IP
                                                            ▼  Upstox
```

Vercel holds **no** Upstox credentials. It authenticates the user, then proxies commands to the
engine over a Cloudflare Tunnel (`cloudflared` is already installed on this machine). The engine
is the only thing that ever holds a token or opens a socket to Upstox.

Engine host options, in order of recommendation:

| Option | Static IP | Cost | Note |
|---|---|---|---|
| **Indian VPS** (DigitalOcean BLR, Hetzner, E2E) | yes, native | ₹500–1,500/mo | Lowest NSE latency. Recommended. |
| **Fly.io** with dedicated IPv4 | yes, \$2/mo addon | ~₹700/mo | Deploys from the same Dockerfile. |
| **This Mac** + `PUT /v2/user/ip` on boot | self-managed | free | Must stay awake 09:00–15:30 IST. A sleep or network blip with a position open is a real risk — the GTT bracket (§0.1) and watchdog (§4.4) exist partly to survive this, but it is the weakest option. |

The engine ships with a `Dockerfile`, `fly.toml` and a `launchd` plist so the choice can be
deferred to Phase 11. Phases 0–10 are host-agnostic and develop locally in `PAPER` mode.

---

## 13. Still to confirm

- **Engine host** — deferrable to Phase 11; nothing before then depends on it.
- **Per-trade spend ceiling and max deployed capital** — needed before the first `LIVE` arm,
  not before the build. Defaults of ₹10,000/trade and ₹50,000 deployed ship in config until set.
