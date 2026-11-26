# TradeForger — Strategies, Stock Selection and Trading Rules

The current reference for how the engine picks stocks, finds setups, decides
to enter, sizes, exits and protects capital. Numbers are the code's, and the
"production" values are what the server runs (AutoPilot settings, 26 Nov 2026).
Research history and backtest tables live in [05-TRADING-SYSTEM.md](05-TRADING-SYSTEM.md).

> **Status, 26 Nov 2026.** The server runs in **PAPER** with **AutoPilot on**
> (it stays on across restarts). LIVE is armed only from the dashboard. In LIVE,
> only human-APPROVED strategies may lead a trade — today that is one intraday
> strategy, `PDH_PDL_CPR`. No intraday strategy has a proven edge after
> charges yet; paper trading is collecting forward results.

---

## 1. The pipeline

```
every 5 min  STOCK SELECTION   today's liquid movers from the whole NSE market + default list
every 2 s    ANALYSIS          every strategy evaluates every watched stock on CLOSED bars
             RANKING           the strongest tradeable vote leads; ensemble quality 0–100
             ENTRY RULES       ~30 checks; any one failing blocks the trade (dashboard shows which)
             AI REVIEW         can block or halve the size, never adds a trade
             SIZING & ORDER    risk-based quantity, charges check, margin check, GTT bracket
every 1 s    EXITS             stop/target at the broker, optional exits, 15:05 square-off
always       CIRCUIT BREAKERS  daily loss, losing streak, stale feed... stop new entries
```

At most **one entry per 2-second cycle**: the highest-quality setup that passes every rule.

---

## 2. Stock selection

### 2.1 Where the watchlist comes from
| Source | What |
|---|---|
| Default universe | 11 liquid large caps: RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN, BHARTIARTL, LT, ITC, KOTAKBANK, TATAMOTORS |
| Manual watchlist | Up to 40 stocks you add from the dashboard |
| **Auto-pick "today's movers"** | Re-picked every **5 minutes, 09:20–14:45 IST**, from **every NSE EQ-series company share** (~2,400) |

The auto-pick is **not limited to the Nifty 50**. On real data its picks were
about 25–33% Nifty 50, 28–31% Midcap 150, 19–22% Smallcap 250 and the rest
other NSE stocks.

### 2.2 Auto-pick rules (in order)
1. **Company shares only** — ISIN starts with `INE`; ETFs and fund units (`INF…`) are excluded. EQ series only (no BE/T2T).
2. **One quote pass** over all of them, 500 instruments per request (no candles needed).
3. **Filters** — a stock must pass all of these:

| Filter | Production value |
|---|---|
| Price band | **₹50 – ₹3,000**, and never above what one trade can buy (₹10,000 per-trade cap) |
| Day turnover | **≥ ₹25 crore**; before 12:15 IST the floor is scaled with time since the open (20% at the open → 100% by 12:15), so morning mid/small-cap movers qualify |
| Day move | **0.4% to 5.0%** from the previous close (a smaller move isn't moving; a bigger one is usually exhausted) |
| Holding the move | Buys: up on the day, at/above today's open, in the upper half of the day's range. Shorts: the mirror. |
| Direction | **Buy only** (production) — or short only / both |
| **Bid-ask spread** | **≤ 0.15%** of price (judged when both sides are quoted) |
| **Price band (circuit)** | 2% / 5% circuit-band stocks excluded (NSE puts surveillance-listed, illiquid and T2T stocks on these) |
| **Near the circuit** | Excluded within 1.5% of the circuit the move is heading for (it can freeze with no exit) |

4. **Ranking:** `log10(turnover) × move score × (0.5 + range strength)`. The move
   score peaks at 0.5–3.5% and is cut steeply above 3.5%, so a liquid stock
   early in its move beats an over-extended spike.
5. **Top 15** are kept. A current pick that still ranks in the top 30 keeps its
   place, so the list doesn't churn (every change resets a setup's clock).
6. New picks immediately load candles (prior sessions, today, 1 year daily),
   get a REST quote and subscribe to the live WebSocket feed. Any stock without
   a tick for 3 s is polled by REST.

If the instrument master fails to download at boot, the engine retries every
5 minutes instead of trading only the 11 default stocks all day.

---

## 3. The strategies

24 strategies: 19 intraday, 5 swing. Each one scores its own checks into a
**confidence 0–100** and only votes above its minimum. All intraday strategies
read **closed bars only** — a signal can never come from a candle still forming.

**Trend** strategies join a move; **fade** (counter-trend) strategies bet
against an overstretched one and are exempt from the trend and NIFTY filters
(they are blocked only by a 15-minute trend running against them).

**Status** is what the production registry says today:
- **LIVE** — has a human-APPROVED version; may lead LIVE trades.
- **Paper** — not validated or not approved; trades in PAPER only.
- **Failed** — its parameters failed validation (walk-forward, out-of-sample, cost stress); blocked in every mode while "Skip failed strategies" is on.

### 3.1 Intraday, 5-minute bars
| Strategy | Type | Entry | Stop | Status |
|---|---|---|---|---|
| `ORB_SUPERTREND` | trend | Close beyond the 09:15–09:30 opening range, confirmed by Supertrend, EMA9/21, ADX, RVOL ≥ 1.5×, VWAP side, RSI room | 1.5 ATR | Paper |
| `VWAP_PULLBACK` | trend | Trend day pulls back to session VWAP and resumes with a rejection bar | 0.5–2.5 ATR | **Failed** |
| `SUPERTREND_MOMENTUM` | trend | Fresh Supertrend flip with EMA21 slope, RVOL expansion, rising ADX | ≥ 0.5 ATR, ≤ 1.5 ATR | **Failed** |
| `BB_SQUEEZE_BREAKOUT` | trend | Bollinger bandwidth at a lookback low, then a close outside the band on volume | ≥ 0.5 ATR, ≤ 1.5 ATR | **Failed** |
| `GMMA_TREND` | trend | Guppy short (3–15) and long (30–60) EMA ribbons separate cleanly; long ribbon sloping; 15-min trend agrees | 0.75–2.5 ATR | Paper |
| `SMC_STRUCTURE` | trend | First close beyond the last confirmed swing (break of structure / change of character), weighted by a fair-value gap | beyond the opposite swing | Paper |
| `TECHNICAL_COMPOSITE` | trend | EMA12/26 trend and OBV first align, weighted by ADX, RSI, Bollinger room, VWAP | ≥ 1 ATR | **Failed** |
| `GAP_AND_GO` | trend | 1–4.5% opening gap on 1.6× opening volume (same-time baseline); close beyond the first 15-min candle | 0.5–3 ATR | Paper |
| `EMA_CROSS_9_21` | trend | EMA9/21 cross with the 15-min EMA20/50 trend agreeing and ADX > 22 | beyond the recent swing, 0.5–2.5 ATR | Paper |
| `PDH_PDL_CPR` | trend | Narrow central-pivot-range day, first close beyond the previous day's high/low on 1.3× volume | 1–3 ATR | **LIVE** (approved v2 uses a 0.9% CPR width; the code default is 0.3%) |
| `BB_RSI_REVERSION` | fade | ADX < 18; pierce of the 2-SD band with RSI < 25 / > 75 that closes back inside; target session VWAP | 0.5–2.5 ATR | Paper |
| `FAILED_BREAKOUT_TRAP` | fade | Thin-volume (< 1.2×) break of the opening range or previous day high/low that closes back inside within 2 bars | beyond the failed extreme | Paper |
| `OI_WALL_REVERSAL` | fade | Bounce off the peak put-OI strike (or rejection at peak call-OI) while writers add OI | beyond the wall | Paper (needs the F&O desk, off) |

### 3.2 Intraday, 15-minute bars (wider stops, lower charge drag)
| Strategy | Type | Entry | Stop | Status |
|---|---|---|---|---|
| `ORB_SUPERTREND_15M` | trend | 30-min opening range, first 15-min breakout bar only; Supertrend, EMA9/21, ADX ≥ 25, RVOL ≥ 1.5×, VWAP, RSI room, 0.75% volatility floor | 2 ATR | **Failed** |
| `PDH_PDL_CPR_15M` | trend | Narrow CPR (≤ 0.3%) breakout beyond PDH/PDL on 1.5× volume | 0.75–2.5 ATR | Paper |
| `EMA_CROSS_9_21_15M` | trend | 15-min EMA9/21 cross with EMA20/50 trend, ADX > 22, RVOL ≥ 1.2× | 0.75–2.5 ATR | Paper |
| `SMC_STRUCTURE_15M` | trend | 15-min break of structure + fair-value gap on ≥ 1.2× volume | ≥ 0.75 ATR | Paper |
| `HOLY_GRAIL_15M` | trend | Linda Raschke: ADX ≥ 30 trend, pullback to the 20-EMA, enter when a bar breaks the pullback bar | beyond the pullback swing, 0.75–2.5 ATR | Paper (new) |
| `INSIDE_BAR_15M` | trend | Inside bar near PDH, PDL or VWAP, then a close beyond the mother bar on 1.2× volume | mother bar's other end, 0.75–2.5 ATR | Paper (new) |

### 3.3 Swing, daily bars (swing segment is **off** in production)
| Strategy | Entry | Status |
|---|---|---|
| `EMA_TREND_SWING` | Daily EMA20/50 trend with MACD and an RSI pullback | LIVE |
| `RSI_MEAN_REVERSION` | Short-period RSI deeply oversold above the long-term trend | LIVE |
| `DONCHIAN_BREAKOUT` | First close beyond the N-day high on volume, ADX filter | LIVE |
| `ICHIMOKU_CLOUD` | Tenkan/Kijun cross confirmed by the cloud and Chikou span | LIVE |
| `CANDLESTICK_PATTERNS` | 15 classic patterns, only at a pullback inside the EMA50 trend | LIVE |

A swing SELL is never automated — on a delivery product it would sell shares out of your demat account.

### 3.4 Targets
Strategies propose a target (mostly 2R). For **trend** strategies the engine
restates it at **2.5× the risk** (production `targetR`), then caps it at
**today's open ± 1.5 × the 14-day daily ATR**. A setup whose cap is already
behind the price, or with less than **0.5 daily ATR** of room left, is skipped.
Fade strategies keep their own level targets (VWAP, the far OI wall).

---

## 4. Ranking: the ensemble quality score

For each stock, the strongest vote that is **allowed to trade** leads — a vote
a rule would block (wrong direction, unapproved in LIVE, against the trend,
stop under the minimum) cannot hide a tradeable one. Then:

```
quality = lead confidence
        + 8 per agreeing strategy (max +24)
        − 20 × (opposing confidence ÷ lead confidence), per opposing strategy
        + 5 per unit of reward:risk above 2 (max ±10)
```
- Capped at **40** if an opposing vote is within 10 points of the lead (a coin flip).
- Capped at **30** if the stop is closer than 0.2% of price.
- Every setup is re-priced at the live LTP; one already past its stop or target is invalid.

---

## 5. Entry rules — every one must pass

All checked in `decide()` (`apps/engine/src/live.ts`). The dashboard lists
every rule blocking each setup. Production values:

### Timing
| Rule | Value |
|---|---|
| Entry windows | **09:30–11:30** and **13:30–14:45** IST (09:15–09:29, the midday 11:30–13:30 and after 14:45 are blocked) |
| Setup must hold unchanged | **6 s** |
| Setup freshness | entered only within **10 min** of first signalling |
| Re-entry cooldown | **5 min** after a position in the same stock closes |

### Direction, trend and market
| Rule | Value |
|---|---|
| Direction | **Buy only** |
| 15-min trend | price on the trade's side of 15-min VWAP, and the 15-min trend (EMA20/50 + ADX ≥ 20) not against it |
| **With the NIFTY** | longs only while the NIFTY's **15-min EMA20 > EMA50**; shorts on the mirror. The extra "NIFTY above today's open" condition is an option, **off** (it blocked 42% of entries as "no clear direction" and did worse in both halves of the Aug–Nov test) |
| Relative strength | buy only stocks up more than the NIFTY today (short only weaker ones) |
| No chasing (VWAP) | trend entries ≤ **5 ATR** from session VWAP |
| No chasing (entry) | live price ≤ **0.5 ATR** past the signal bar's close, ≤ 0.75 ATR past the breakout trigger |

### Trade quality
| Rule | Value |
|---|---|
| Quality | **≥ 70** |
| Reward:risk at strategy levels | **≥ 1.5** |
| Reward:risk after all charges | **≥ 1.25** (checked at the real quantity) |
| Minimum intraday stop | **0.65%** of price (charges are a near-fixed share of the money traded) |
| Charges vs risk | round-trip charges ≤ **20%** of the planned 1R risk |
| Stop-hunt guard | a stop sitting on a stop cluster (PDH/PDL, opening range, equal highs/lows, round number) is moved just beyond the sweep zone, if that is a small move |

### Strategy gating
| Rule | Value |
|---|---|
| LIVE | the lead must have a human-**APPROVED** version |
| Failed validation | blocked in every mode (Skip failed strategies: on) |
| Losing strategy | paused after **20+** of its own trades in this mode with negative expectancy (Pause losing strategies: on) |

### Portfolio limits
| Rule | Value |
|---|---|
| Entries per day | **5** (morning **5**, afternoon **3**) |
| Open positions | **5** total, **2** per strategy, **3** per direction |
| Per sector | **2** open positions per NSE industry |
| Per stock | one position at a time |

---

## 6. AI review

Runs only on a setup that already passed every rule.
- **Three built-in checks:** geometry and timing, candle/breakout pattern (including RSI exhaustion > 75 / < 25), and an estimated win-rate score.
- **Language models:** Google Gemini and Groq (qwen), 1.5–4 s each; a model that fails or times out does not vote.
- **Verdict:** any REJECT, ≥ 2 CAUTION votes, or CAUTION with exhaustion / thin volume **blocks**; a single CAUTION or no CONFIRM **halves the size**; otherwise full size.
- AI never picks stocks and never adds a trade.

---

## 7. Sizing and order placement

| Step | Production |
|---|---|
| Capital | ₹50,000 risk capital (in LIVE: the smaller of that ceiling and the real Upstox balance, refreshed every minute) |
| Size | **risk-based: 1.5% of capital at the stop** → `quantity = ₹750 ÷ |entry − stop|` (risk % hard-capped at 2%) |
| Caps (smallest wins) | ₹10,000 per trade · intraday exposure ≤ **3×** capital · deployed-capital ceiling · 1% of the stock's daily volume · ₹2,000 minimum ticket |
| AI multiplier | 1× or 0.5× |
| Charges check | brokerage, STT, exchange, SEBI, stamp duty and GST at the real quantity; net R:R must clear 1.25 |
| Margin check (LIVE) | Upstox quotes the exact margin; the order shrinks to fit free funds (5% kept back) or is skipped |
| Order | one Upstox **GTT bracket** (entry + target + stop in one order, stop held at the broker), market price protection on every leg |
| Rate limit | 8 orders/s, under SEBI's 10/s retail-algo threshold |

---

## 8. Exits and trade management

| Exit | When | Production |
|---|---|---|
| Target / stop-loss | at the broker, via the GTT bracket | always |
| Staged profit trail | at **+1.2R** the stop locks **+0.35R**; from **+1.6R** it trails **1.25 ATR** behind the best price | **on** (your setting; 12-month test: slightly worse than a fixed target) |
| No-follow-through exit | close a flat/losing trade that hasn't gone +0.25R within 4 strategy bars | **off** (cut stop-outs 32% → 18% with expectancy unchanged) |
| Exchange trailing GTT | trails at the initial risk distance from entry | off |
| Pending entries cancelled | **15:00** | always |
| Intraday square-off | **15:05**, on a 1-second timer independent of the price feed | always |
| Per-trade backstop | a loss running 15% past the planned risk (a stop that failed or gapped) | always |
| Kill switch | dashboard: flattens everything | manual |

---

## 9. Circuit breakers — block new entries (exits still allowed)

| Breaker | Trips at |
|---|---|
| Daily loss | **2%** of capital (₹1,000 on ₹50,000), realised + open |
| Losing streak | **3** losses in a row |
| Orders | 40 per day, 6 per minute |
| Rejections | 3 in 5 minutes |
| Price feed stale | no tick for 10 s during market hours |
| Margin used | ≥ 80% of capital |
| Engine/broker mismatch | an orphaned position (also blocks discretionary exits; the 15:05 square-off still runs) |
| Outside entry windows | see §5 |
| Upstox maintenance | 00:00–05:30 IST (blocks exits too) |

---

## 10. Modes, restarts and deployment

- **PAPER vs LIVE is chosen on the dashboard.** Arming LIVE needs the confirmation phrase, a valid Upstox login and a passing preflight; it lasts until the session ends. Open paper positions stay on paper.
- **After any restart the engine comes back in PAPER** (LIVE must be re-armed by hand — deliberate). AutoPilot comes back **on** (`TF_AUTO_ENABLED=true`).
- **Deploys are refused during market hours** (Mon–Fri 09:00–15:35 IST) unless `FORCE_DEPLOY=1`: on 26 Nov, five mid-session deploys left the engine re-arming instead of trading.
- Trades are filed as LIVE or PAPER by the broker that held them, not by the dashboard mode at exit.

---

## 11. How good is it? (honest summary)

- On 3 months of real 5-minute data (Aug–Nov 2026, 40 large/mid/small caps), the strategies allowed in paper, with the current rules, lose about **0.05–0.12R per trade** after charges — much better than before the 26 Nov changes (−0.20R), but **not yet profitable**.
- The audit of stop-outs: **52–56% never went above +0.25R** — the losses come from entries without follow-through, not from stops that are too tight (only 1–2% hit the target after being stopped).
- Real Upstox trades so far: **12 trades, −₹71, −0.09R** average.
- Approve a strategy for LIVE only after it is positive in paper and passes Strategy Lab validation; more capital does not create an edge.

---

## 12. Where it lives in the code

| Part | File |
|---|---|
| Auto-pick movers | `packages/strategy/src/screener.ts` (`pickUniverse`, `executionBlocker`), `apps/engine/src/main.ts` (`refreshAutoUniverse`) |
| Strategies | `packages/strategy/src/strategies/*.ts`, `intraday.ts` (ORB), `swing.ts`; registry in `catalog.ts` |
| Ensemble / quality | `packages/strategy/src/ensemble.ts` |
| 15-min trend, NIFTY direction, relative strength | `packages/strategy/src/bias.ts` |
| Stop clusters, structure targets | `packages/strategy/src/liquidity.ts` |
| Entry rules, live analysis | `apps/engine/src/live.ts` (`decide`, `canLead`, `LiveAnalyzer`) |
| AI review | `packages/ai/src/reviewer.ts`, `consensus.ts` |
| Sizing, orders | `packages/risk/src/sizing.ts`, `apps/engine/src/main.ts` (`enterEquity`), `packages/broker/src/upstox.ts` |
| Exits, square-off | `apps/engine/src/trader.ts` (`manage`) |
| Circuit breakers, session times | `packages/safety/src/breakers.ts`, `packages/core/src/clock.ts` |
| Strategy versions and approvals | `apps/engine/src/registry.ts` |
| Backtester | `packages/backtest/src/engine.ts` |
| Production-settings filter test | `apps/engine/src/filters.test.ts` |
