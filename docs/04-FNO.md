# F&O Desk — live analysis and automated entry

Added 2026-11-18. Extends the v1 scope (§11 of `00-PLAN.md`) from intraday equity to
index and stock derivatives. Off by default: `TF_FNO_ENABLED=true` or the dashboard toggle.

## What it trades

| Instrument | Default | Direction | Worst case |
|---|---|---|---|
| Long options (CE/PE) | **yes** | bullish → buy CE, bearish → buy PE | the premium paid |
| Futures | opt-in (`TF_FNO_INSTRUMENT=FUTURES`) | long or short | **uncapped** — a gap goes through the stop |
| Option writing | **never** | — | unbounded; deliberately not implemented |

Every order is a single Upstox GTT `MULTIPLE` (ENTRY + TARGET + STOPLOSS, optional
`trailing_gap`), so the stop lives at the exchange from the moment the entry fills.

## Pipeline

```
instrument master (NSE.json.gz, daily)
  └─ per underlying: index → near-month FUTURE as signal source (indices have no volume)
                     stock → the equity itself
5-min candle close on signal key
  → IntradayProfile (ORB + Supertrend + VWAP + RVOL …)     same code as equity
  → AI consensus review (can only reduce size / block)
  → option chain (≤10 s old) → analytics → veto if bias ≥ 50 against
  → expiry: first with ≥ TF_FNO_MIN_DTE days (no 0-DTE)
  → strike: liquid (spread ≤ 3 %, OI ≥ 5 % of busiest), |Δ| closest to 0.5
  → premium SL/target via Δ·m + ½Γ·m², SL clamped to 10–35 % of premium, R:R ≥ 1.5
  → IV ≤ 60 %, theta ≤ 12 %/day of premium
  → sizing in whole lots: budget / risk / max-lots, spend & deployed caps, freeze qty
  → circuit breakers re-checked → GTT bracket → Trader (fills from broker events only)
```

Exits beyond the bracket: 15:10 IST square-off, a **time stop** for options that are
flat or losing after `TF_FNO_TIME_STOP_MIN` (theta guard), the per-trade loss limit,
manual exit and the kill switch (NUCLEAR disables both `NSE_EQ` and `NSE_FO`).

## Live chain analytics (dashboard F&O Desk, `GET /fno/chain`)

PCR (OI and volume), max pain, call wall / put wall (max OI above/below ATM), ATM IV,
OTM put–call IV skew, ATM straddle and the expected move it implies, and the
price/OI buildup quadrant for calls and puts near ATM. These roll into a bias score
(−100…100) whose every point is listed in `notes`. Bias is a **filter**, never a
trade trigger: it vetoes at ±50 against, adjusts confidence at ±20.

`POST /fno/analyze {symbol}` builds the full setup on demand without placing anything.

## Sizing reality check

With the default `TF_MAX_SPEND_PER_TRADE=10000`, one lot must cost under ₹10,000:

| Contract (Nov 2026) | Lot | ATM premium | One lot |
|---|---|---|---|
| NIFTY | 65 | ~₹150 | ~₹9,750 — fits, barely |
| BANKNIFTY | 30 | ~₹430 | ~₹12,900 — **rejected** |
| RELIANCE | 500 | ~₹30 | ~₹15,000 — **rejected** |

Raise the ceiling deliberately if you want these; the rejection names the binding cap.
Futures need exchange margin from `POST /v2/charges/margin` (trading token + static IP);
without it a futures plan is refused rather than sized on a guess.

## Known limits

- Positions live in engine memory. A restart forgets open positions (the exchange-side
  GTT still protects them, and the reconciler reports them as unknown). Persisting to
  the `positions` table is the next piece of work.
- Partial entry fills are booked at the filled quantity; the GTT exit legs are for the
  ordered quantity. Upstox's exact behaviour here is unverified — watch the first
  live partial by hand.
- Paper fills for options use the last traded price plus slippage, not the
  bid/ask; real spreads on far strikes will be worse.
- The chain's OI/greeks are a REST snapshot (refresh `TF_FNO_CHAIN_REFRESH_SEC`),
  not streamed.
