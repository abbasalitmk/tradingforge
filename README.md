# TradeForger

Autonomous equity trading on Upstox. Personal, single-account.

**Status: engine runs in PAPER, not trading.** The engine boots, passes preflight,
connects to the live V3 feed and serves a control API — but it subscribes to no
instruments yet (no scanner), so no signal is ever evaluated. There is no live order
path. See
[`docs/00-PLAN.md`](docs/00-PLAN.md) for the full plan and
[Build status](#build-status) below for what exists.

> Signals are research support, not investment advice. You are solely responsible
> for every order this system places. Verify all account data directly on Upstox.

---

## Why it is shaped this way

Four findings from the live Upstox API drove the architecture. Each contradicts a
common assumption, and the details are in [`docs/01-UPSTOX-API.md`](docs/01-UPSTOX-API.md).

**GTT `MULTIPLE` is a native OCO bracket.** Entry + target + stop-loss in one order,
with a server-side trailing stop. Exits live at the exchange, so they survive our
process dying. The watcher is a reconciliation backstop, not the exit mechanism.

**The sandbox cannot host a strategy loop.** It exposes seven order endpoints and no
market data — it cannot tell you a price. So the real test bed is an internal paper
broker driven by the live feed, and the sandbox is demoted to payload conformance.

**Account APIs require a static IP.** Verified: funds, positions, orders and kill
switch return `401 UDAPI1221` from an unlisted address, while market data works from
anywhere. That splits the system into a data plane (analytics token, valid to
2027-09-14) and a trading plane (daily token, IP-locked) — and it means the engine
cannot run on Vercel.

**Order fills stream over an authenticated WebSocket.** Upstox webhooks carry no
signature of any kind, so webhook payloads are treated as hints that trigger an
authenticated re-poll, never as facts.

---

## Layout

```
apps/web/           Next.js control plane — UI, OAuth callback, webhook receivers.
                    Stateless. Holds no Upstox credentials. Safe on Vercel.
packages/core/      Domain types, Result, injectable clock, integer-paise money,
                    ULIDs, execution state machine.
packages/db/        Postgres schema, SQL migrations, hash-chained audit log.
packages/safety/    Circuit breakers, mode ladder, three-level kill switch.
packages/upstox/    Typed API client, shared rate limiter, token lifecycle.
packages/broker/    BrokerPort + deterministic paper fill simulator.
packages/risk/      Position sizing under hard rupee ceilings.
docs/               Plan, API reference, webhook security design.
```

## Setup

Requires Node 22+, Postgres and Redis. Both services are already running locally
via Homebrew.

```bash
npm install --legacy-peer-deps     # see Known issues
createdb tradeforger
cp .env.example .env.local         # fill in credentials

DATABASE_URL=postgresql://$USER@localhost:5432/tradeforger npm run migrate
npm test                           # 203 tests
npm run typecheck
```

Live read-only smoke test of the data plane:

```bash
UPSTOX_ANALYTICS_TOKEN=… npm run probe
```

## Deploying the control plane

```bash
vercel login
./scripts/deploy-web.sh            # deploys, prints the webhook URLs
```

Paste the printed URLs into <https://account.upstox.com/developer/apps> and enable
**both** "Order updates" and "GTT order updates" — GTT updates default to off.
Details in [`docs/02-WEBHOOKS.md`](docs/02-WEBHOOKS.md).

---

## Safety model

Nothing reaches real money without all of these being simultaneously true:

- `TF_MODE=LIVE` **and** `LIVE_TRADING=true` in the environment
- an exact typed confirmation phrase
- a per-session arm that **auto-expires at 15:30 IST** — it cannot stay live overnight
- every circuit breaker clear

The breakers are pure functions over an observable snapshot, so the entire risk
posture is a table of test cases rather than something you have to reason about at
runtime. Exits stay permitted under nearly every trip; a breaker that blocked exits
would turn a bad day into an unbounded one.

The audit log is append-only and hash-chained **in the database**, not in application
code. `UPDATE`, `DELETE` and `TRUNCATE` are all rejected by triggers, and
`verify_audit_chain()` locates the exact row if anything is altered out of band.

### Position sizing

Three user-selectable modes, then the same hard caps in all three — smallest wins:

| Mode | Input | Quantity |
|---|---|---|
| `FIXED_QTY` | "buy 25 shares" | exactly 25, subject to caps |
| `FIXED_BUDGET` *(default)* | "spend at most ₹50,000" | `floor(budget / price)` |
| `RISK_BASED` | "risk 1% of capital" | `floor(risk / (entry − stop))` |

Caps: per-trade rupee ceiling, total deployed capital, 1% of average daily volume,
available margin. `FIXED_QTY` is the mode that most needs them — 25 shares is ₹2,500
on one stock and ₹75,000 on another.

---

## Build status

| Phase | State |
|---|---|
| 0a Control plane, webhooks, OAuth callback | ✅ |
| 0b Schema, migrations, audit log | ✅ |
| 1 Safety layer | ✅ 47 tests |
| 2 Upstox client, rate limiter, tokens | ✅ verified against live API |
| 3 Broker port + paper simulator + sizing | ✅ 58 tests |
| 4 Data plane: protobuf V3 feed, portfolio feed, backfill, aggregator | ✅ live-verified |
| 5 Indicators ported from `stockwatch` | ✅ 31 tests |
| 6 Intraday strategy profile | ✅ 20 tests |
| 7 Execution state machine + reconciler | ✅ 18 tests |
| 9 Groq AI confirmation layer | ✅ benchmarked live |
| — Engine process (boots, preflight, feed, control API, kill switch) | ✅ |
| 4b Scanner + watchlist subscription | ❌ engine subscribes to nothing yet |
| 8 Backtest / walk-forward engine | ❌ |
| 10 Dashboard UI (beyond the status page) | ❌ |
| 11 Chaos tests, hardening | ❌ |

Before any real capital: unit tests → tick replay → walk-forward backtest →
20+ paper sessions → ₹5,000 live micro → scale. The gate that matters is **positive
expectancy after costs**, not win rate.

## Known issues

- `npm install` needs `--legacy-peer-deps`. npm 10.9.0 has an arborist bug
  (`Cannot read properties of null (reading 'edgesOut')`) resolving vitest 5's peer
  set. Upgrading npm should remove the need.
- The Vercel CLI on this machine is v50 against a current v59, and is not logged in.
