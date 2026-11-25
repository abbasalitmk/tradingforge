# TradeForger — How Automated Trading Works

How the engine picks stocks, finds setups, decides to enter, sizes and places
orders, and exits. Every number here is what the code uses. Settings marked
**(AutoPilot)** can be changed on the dashboard.

> **Status (25 Nov 2026).** Sections marked **[deployed]** run on the server
> now. Sections marked **[ready, not deployed]** are built and tested, waiting
> for deployment (live engine disarmed to `PAPER` for new entries while open
> Upstox brackets remain managed).
>
> **Honest summary:** on the full 12-month real NSE benchmark (24 stocks,
> Nov 2025 – Nov 2026), legacy 5-min trend strategies lost money after charges
> and their `@v1` approvals are retired by migration `0007`. With full live-parity
> filters, ADR-capped targets, cost-buffered staged trailing, and 15-min variants,
> `PDH_PDL_CPR` (`+0.627R`, 4/4 quarters) and tuned `GAP_AND_GO` (`+0.343R`, 31 trades)
> stay profitable even under 2× cost stress, while `ORB_SUPERTREND_15M` cuts
> loss per trade by ~74% vs `5m` (`-0.049R` vs `-0.187R`). Keep PAPER mode on
> during soak verification before re-arming LIVE.

---

## 1. The pipeline at a glance

```
Every 5 min   ── 1. STOCK SELECTION ──  which stocks to watch
Every 2 sec   ── 2. ANALYSIS ─────────  18 strategies vote on each stock (closed 5-min bars)
              ── 3. RANKING ──────────  ensemble quality score 0–100
              ── 4. ENTRY RULES ──────  ~25 checks; any one failing blocks the trade
              ── 5. AI REVIEW ────────  can block or halve the size, never add a trade
              ── 6. SIZING & ORDER ───  risk-based size, margin check, GTT bracket order
Every 1 sec   ── 7. EXITS ────────────  stop / target at the exchange, 15:05 square-off
Always        ── 8. CIRCUIT BREAKERS ─  stop all new entries when something is wrong
```

The engine takes at most **one entry per 2-second cycle**: the highest-quality
setup that passes every rule.

---

## 2. Stock selection **[deployed]**

Three sources are merged into one watch list:

| Source | What |
|---|---|
| Default universe | 11 liquid large caps: RELIANCE, TCS, INFY, HDFCBANK, ICICIBANK, SBIN, BHARTIARTL, LT, ITC, KOTAKBANK, TATAMOTORS |
| Manual watchlist | Stocks you add from the dashboard |
| **Auto-pick "today's movers"** (AutoPilot, on) | Re-picked every **5 minutes** from 09:20 to 14:45, from the whole NSE market |

### Auto-pick rules
1. **Company shares only.** ISIN starts with `INE` (ETFs and fund units, `INF…`, are excluded).
2. One quote pass over every NSE EQ stock, 500 per request. No candles are needed for this step.
3. Filters:
   - **Price band:** between AutoPilot min/max price (server now: ₹100–₹500), and never above what one trade can buy (`TF_MAX_SPEND_PER_TRADE`).
   - **Day turnover ≥ ₹25 crore** (AutoPilot), so entries and exits fill easily.
   - **Day change between 0.4% and 5.0%** (sweet-spot score peaking ≤ 3.5%). Below 0.4% the stock isn't moving; above 5.0% late breakout chasing dominates.
   - **Holding the move.** For buys: up ≥ 0.4% on the day, price ≥ today's open, and in the upper half of the day's range. Shorts use the mirror. With direction BOTH, either qualifies.
4. **Ranking:** `log10(turnover) × changeScore × (0.5 + range strength)`. A liquid mover not already over-extended beats an exhausted spike.
5. **Top 15** (AutoPilot) are kept. Current picks stay while they still qualify, so the list doesn't churn.
6. New picks immediately hydrate candles, poll initial REST quotes, and subscribe to the WebSocket feed (with per-instrument ≥ 3s tick staleness REST fallback).

F&O underlyings (NIFTY, BANKNIFTY) are added when the F&O desk is on (currently off).

---

## 3. Analysis: the strategies

Every 2 seconds each watched stock is re-analysed. **Only closed 5-minute bars
are used** (AutoPilot: closed-bar entries, on). A signal can never come from a
candle that's still forming, which was the PNB mistake on 23 Nov.

### The 22 strategies

**Intraday, 5-min bars: trend-following (hard prerequisites: `RVOL ≥ 1.5`, `RSI < 72 / > 28`, fresh breakouts)**

| Strategy | Idea in one line | Approved for LIVE |
|---|---|---|
| ORB_SUPERTREND | Break of the 09:15–09:30 range, confirmed by Supertrend, EMA9/21, ADX, RVOL, VWAP | retired (`0007`) |
| VWAP_PULLBACK | Trend day pulls back to VWAP and resumes with a rejection candle | retired (`0007`) |
| SUPERTREND_MOMENTUM | Fresh Supertrend flip with EMA21 slope, volume and rising ADX | retired (`0007`) |
| BB_SQUEEZE_BREAKOUT | Bollinger bands at their narrowest, then a close outside on volume | retired (`0007`) |
| GMMA_TREND | Guppy short/long EMA ribbons separate cleanly, 15-min trend agrees | retired (`0007`) |
| SMC_STRUCTURE | Close beyond the last swing high/low (break of structure), fair-value gap | retired (`0007`) |
| TECHNICAL_COMPOSITE | EMA12/26 trend + OBV align, weighted by ADX, RSI, Bollinger, VWAP | retired (`0007`) |
| GAP_AND_GO | 1–4.5% opening gap on 1.6× opening volume; break of the first 15-min candle | paper only |
| EMA_CROSS_9_21 | EMA9/21 cross with 15-min EMA20/50 agreeing, ADX > 22 | paper only |
| PDH_PDL_CPR | Narrow central pivot range day; close beyond the previous day's high/low on 1.8× volume | paper only |

**Intraday, 15-min bars** (fewer false breaks, lower cost drag as % of stop)

| Strategy | Idea in one line | Approved for LIVE |
|---|---|---|
| ORB_SUPERTREND_15M | 15-min close beyond the opening range with Supertrend, EMA9/21, ADX, RVOL ≥ 1.5, VWAP | paper only |
| PDH_PDL_CPR_15M | Narrow-CPR 15-min breakout beyond PDH/PDL on volume | paper only |
| EMA_CROSS_9_21_15M | 15-min EMA9/21 cross aligned with 15-min EMA20/50 trend and RVOL ≥ 1.5 | paper only |
| SMC_STRUCTURE_15M | 15-min Break of Structure + Fair Value Gap with RVOL ≥ 1.5 | paper only |

**Intraday, 5-min bars: counter-trend (fade a move)**

| Strategy | Idea in one line | Approved for LIVE |
|---|---|---|
| BB_RSI_REVERSION | ADX < 18 range, pierce of the 2-SD band with RSI < 25 / > 75, close back inside; target VWAP | paper only |
| FAILED_BREAKOUT_TRAP | Thin-volume break of the opening-range/previous-day level that closes back inside within 2 bars | paper only |
| OI_WALL_REVERSAL | Bounce off the peak put-OI strike (or rejection at peak call-OI) while writers add OI; needs F&O desk | paper only |

**Swing, daily bars** (swing segment is currently **off**)

| Strategy | Idea | Approved |
|---|---|---|
| EMA_TREND_SWING | Daily EMA20/50 trend + MACD + RSI pullback | ✅ |
| RSI_MEAN_REVERSION | Short RSI deeply oversold above the long-term trend | ✅ |
| DONCHIAN_BREAKOUT | First close beyond the N-day high on volume, ADX filter | ✅ |
| ICHIMOKU_CLOUD | Tenkan/Kijun cross confirmed by cloud and Chikou | ✅ |
| CANDLESTICK_PATTERNS | Daily candle patterns at a pullback inside the EMA50 trend | ✅ |

"Paper only" means the strategy has no human-approved version. In LIVE mode it
can't lead a trade until it passes validation in Strategy Lab and you approve it.

### How each strategy scores itself
Each strategy runs a list of weighted checks (for example "volume above
1.2×"). Its confidence is the share of the total weight that passed (0–100).
Below its own minimum confidence it doesn't vote.

---

## 4. Ranking: the ensemble quality score **[deployed]**

For each stock, the strongest vote that is **allowed to trade** leads. A vote
that a rule would block (wrong direction, unapproved in LIVE, against the
trend) can't hide a tradeable one. The rest are counted as agreeing or opposing:

```
quality = lead confidence
        + 8 per agreeing strategy (max +24)
        − 20 × (opposing confidence ÷ lead confidence), per opposing strategy
        + 5 per unit of reward:risk above 2 (max ±10)
```
- Capped at **40** if any opposing vote is within 10 points of the lead (a coin flip).
- Capped at **30** if the stop is closer than 0.2% of the price.
- Prices are restated at the live LTP. A setup already past its stop or target is marked invalid.

Entry needs **quality ≥ 70** (AutoPilot).

---

## 5. Entry rules: every one must pass

All of these are checked in one place (`decide()` in `apps/engine/src/live.ts`),
and the dashboard shows exactly which one blocked a setup.

### Timing **[deployed]**
| Rule | Value |
|---|---|
| Entry windows | **09:30:00–11:30:00** and **13:30:00–14:45:00** IST |
| Blocked | 09:15–09:29 (opening volatility), 11:30–13:30 (midday chop), after 14:45 |
| Why 09:30, not 09:45 | Over 12 months, entries at 09:30–09:45 averaged −0.08R and 09:45–10:30 −0.23R (the worst slot); starting at 09:30 improved the rule set from −0.20R to −0.18R per trade |
| Setup must hold unchanged | 6 seconds (AutoPilot) |
| Setup freshness | Entered only within **10 min** of first signalling (AutoPilot). A setup that waited behind a full position cap or the midday block is stale. On first sight, its age is measured from earlier bars. |
| Re-entry cooldown | **5 min** after a position in the same stock closes (AutoPilot) |

### Trend and direction **[deployed]**
| Rule | Value |
|---|---|
| Direction filter | Buy only / Short only / Both (AutoPilot; server now: Both). Swing SELL is never automated (it would sell your holdings). |
| 15-min trend filter | Price on the trade's side of 15-min VWAP, and the 15-min trend (VWAP + EMA20/50 + ADX ≥ 20) not fully against it. Strict mode requires all three to agree. Counter-trend strategies are blocked only by a trend against them. |
| No chasing | Trend entries ≤ **5 ATR** from session VWAP (AutoPilot). Blocks entries like PFOCUS, 7.7 ATR below VWAP. |

### Market and stock strength **[ready, not deployed]**
| Rule | Value |
|---|---|
| With the NIFTY | Longs only when NIFTY's 15-min EMA20 > EMA50 **and** it trades above today's open; shorts on the mirror; nothing when NIFTY has no direction (AutoPilot) |
| Relative strength | Buy only stocks up more than NIFTY today; short only those doing worse (AutoPilot) |

### Trade quality **[deployed unless marked]**
| Rule | Value |
|---|---|
| Quality | ≥ 70 |
| Reward:risk (strategy levels) | ≥ 1.5 |
| Reward:risk after all charges | ≥ 1.0 (server setting; default 1.25) |
| Minimum intraday stop | **0.65% of price** (AutoPilot) **[ready, not deployed]**. Stops below cost-viability lose edge to charges. |
| Cost-to-risk ceiling | Round-trip charges + slippage ≤ **20%** of planned 1R risk (AutoPilot) **[ready, not deployed]** |
| Entry chase cap | Blocks live entries drifted > **0.5 ATR** above signal bar close (`barCloseEntry`) or > **0.75 ATR** above `signal.entry` **[ready, not deployed]** |
| Strategy enabled / approved | In LIVE the lead must have an APPROVED version (rejected validations blocked even if previously tagged APPROVED). Strategies losing over 20+ of their own trades are paused. |

### Portfolio limits **[deployed]**
| Rule | Value (server) |
|---|---|
| Entries per day | 15 |
| Entries per session | 5 morning, 3 afternoon |
| Open positions | 5 total, 2 per strategy, 3 per direction |
| Per sector | 2 open positions per NSE industry (Nifty 500 map) |
| One position per stock | yes |

---

## 6. AI review **[deployed + hardened]**

Runs **after** a setup has passed every rule, on that one setup only.
- **Three built-in rule checks:** geometry and timing, candle/breakout pattern (including extreme RSI exhaustion > 75 / < 25), and an estimated win-rate score.
- **Language models:** Gemini and Groq (qwen), with 1.5 seconds each. A model that fails or times out doesn't vote.
- **Verdict:** any REJECT, **≥ 2 CAUTION votes**, or **CAUTION paired with structural exhaustion / thin volume** blocks the trade; single CAUTION or no CONFIRM halves the size; otherwise full size.
- AI never picks stocks or adds trades.

---

## 7. Sizing and order placement **[deployed]**

1. **Capital = your real Upstox account** in LIVE (refreshed every minute; ₹4,000 on 23 Nov). In PAPER it's the configured ₹50,000.
2. **Risk-based size:** `quantity = (capital × 1%) ÷ |entry − stop|`. Risk % is capped at 2%.
3. **Caps, smallest wins:**
   - ₹10,000 per trade
   - intraday exposure ≤ capital × **3** (max leverage, AutoPilot)
   - deployed-capital ceiling
   - 1% of the stock's daily volume
   - minimum ticket ₹2,000
4. **AI size multiplier** (1× or 0.5×).
5. **Charges check:** brokerage + STT + exchange + SEBI + stamp + GST at the real quantity; net R:R must clear the floor.
6. **Margin check (LIVE):** Upstox quotes the margin for the exact order. The order is shrunk to fit the free funds (5% kept back), or skipped. No more "add ₹955" cancellations.
7. **Order:** one Upstox **GTT bracket**, with entry + target + stop-loss as one order. The stop is held at the broker, not visible in the exchange order book. Every leg carries market price protection.
8. **Order rate limit:** 8 per second, under SEBI's 10/sec retail-algo threshold. Place, modify and cancel share one budget.

**[ready, not deployed]**
- **Stop-hunt guard before target restatement:** `guardSetupStop()` adjusts stops off local liquidity clusters (PDH/PDL, opening range, equal highs/lows, round levels; max 0.6 ATR) **before** `restateTarget()` computes final risk & target geometry.
- **2.5R ADR-capped targets:** trend targets target **2.5×** guarded risk (AutoPilot) and are capped at **1.5×** prior-session daily ATR (`maxTargetDailyAtr`); intraday targets already past realistic remaining ADR are invalidated.
- **Cost-buffered staged trailing stop (`trader.ts`):** at **+1.2R** move virtual stop to **+0.35R** (covering brokerage + STT + slippage); from **+1.6R** trail at **1.25 × ATR**, preserving original `stopLoss` for 1R risk accounting.

---

## 8. Exits and circuit breakers **[deployed]**

### Exits
| Exit | When |
|---|---|
| Target / stop-loss | GTT bracket at Upstox. The exit leg is read from the fill price (the PNB stop-out was once mislabelled TARGET). |
| Pending entries cancelled | **15:00** |
| Intraday square-off | **15:05**, on a 1-second timer that doesn't depend on the price feed; still runs if a breaker blocks other exits |
| Per-trade backstop | Only if a loss runs **15% past the planned risk** (a stop that failed or gapped) |
| Kill switch | Dashboard: flattens everything |

### Circuit breakers (block new entries; exits still allowed)
| Breaker | Trips at |
|---|---|
| Daily loss | 2% of capital (`TF_DAILY_LOSS_LIMIT_PCT`) |
| Losing streak | 3 losses in a row |
| Orders | 40/day, 6/minute |
| Rejections | 3 in 5 minutes |
| Price feed stale | no tick for 10 seconds during market hours |
| Margin used | ≥ 80% of capital |
| Engine/broker mismatch | an orphaned position (also blocks discretionary exits; the 15:05 square-off still runs) |
| Outside entry windows | see §5 |

After any restart the engine starts in **PAPER**; LIVE must be re-armed by typing `LIVE`.

---

## 9. How strategies are tested, and current results

### Method
- Backtester on real Upstox 5-min data: fills at the next bar's open, 5 bps slippage, full Indian intraday charges, stop assumed to come first when a bar hits both stop and target.
- **A rule is kept only if it improves results in separate time periods**, never on one period alone.
- LIVE needs a human-approved strategy version after Strategy Lab validation (walk-forward, out-of-sample, cost stress).

### Results: 19 NSE stocks, 22 Sep – 23 Nov 2026 (about 40 sessions)
| Rule set (trend strategies) | Month 1 | Month 2 |
|---|---|---|
| Strategies on their own | −0.32R per trade | −0.32R per trade |
| + 0.5% min stop + stop-hunt guard | −0.18R | −0.15R |
| + NIFTY direction + relative strength | −0.005R | −0.10R |
| **+ 3R targets (full current rule set)** | **+0.09R** | **−0.07R** |

What this means:
- Before charges, the trend strategies have a small edge (+0.05 to +0.09R per trade).
- Charges and slippage cost about 0.3–0.4R per trade on tight 5-min stops. That's the main reason results are near break-even.
- ORB_SUPERTREND, SMC_STRUCTURE and VWAP_PULLBACK were negative in both months under every rule set.
- TECHNICAL_COMPOSITE and SUPERTREND_MOMENTUM were positive in both months.
- Tested and **rejected:** a liquidity-sweep (stop-hunt) strategy (no edge even before charges), breakeven-at-1R and staged trailing stops (worse than a fixed 3R target).
### Results: 12 months, 19 NSE stocks, 24 Nov 2025 – 23 Nov 2026 (about 247 sessions)
Full current rule set (closed bars, entry windows, 15-min trend, NIFTY direction,
relative strength, 0.5% min stop, stop-hunt guard, 3R targets), expectancy per
trade after charges and slippage:

| Strategy | Q1 Dec–Feb | Q2 Mar–May | Q3 Jun–Aug | Q4 Sep–Nov | Year | Trades | Positive quarters |
|---|---|---|---|---|---|---|---|
| ORB_SUPERTREND | −0.13 | −0.16 | −0.23 | −0.14 | −0.17R | 1413 | 0/4 |
| VWAP_PULLBACK | −0.34 | −0.35 | −0.15 | −0.20 | −0.26R | 546 | 0/4 |
| SUPERTREND_MOMENTUM | −0.48 | −0.11 | −0.04 | −0.00 | −0.13R | 376 | 0/4 |
| BB_SQUEEZE_BREAKOUT | −0.40 | −0.07 | −0.33 | +0.13 | −0.13R | 236 | 1/4 |
| GMMA_TREND | −0.26 | −0.26 | −0.12 | −0.12 | −0.18R | 1488 | 0/4 |
| SMC_STRUCTURE | −0.39 | −0.21 | −0.14 | −0.16 | −0.22R | 587 | 0/4 |
| TECHNICAL_COMPOSITE | −0.21 | −0.15 | −0.22 | +0.01 | −0.13R | 736 | 1/4 |
| GAP_AND_GO | n/a | +0.21 | −0.06 | +0.04 | +0.07R | 19 | 2/4 |
| EMA_CROSS_9_21 | −0.30 | −0.21 | −0.06 | +0.03 | −0.12R | 303 | 1/4 |
| **PDH_PDL_CPR** | **+0.16** | **+0.23** | **+0.53** | −0.10 | **+0.19R** | 103 | **3/4** |
| **All trend strategies** | −0.25 | −0.19 | −0.15 | −0.09 | **−0.17R** | 5807 | **0/4** |

Also tested from `marketcalls/vectorbt-backtesting-skills`, and rejected:
Double Momentum (−0.13R, 0/4 quarters) and MACD signal-candle breakout
(−0.17R, 0/4).

**Conclusion:** over a full year, the 5-minute intraday trend strategies
**lose money after charges in every quarter**, even with every filter on. The
two-month result above was a favourable stretch, not the norm.

### Results after live-parity + ADR + cost-buffered trailing upgrades (24 NSE stocks, 24 Nov 2025 – 23 Nov 2026)

Using the live-parity backtester (`entrySessionsOnly`, `htfBias`, NIFTY direction + relative strength, `minStopPct`, `maxTargetDailyAtr: 1.5`, `targetR: 2.5`, `maxChargePctOfRisk: 20`, `INTRADAY_STAGED_TRAIL` `{ breakevenR: 1.2, breakevenLockR: 0.35, trailFromR: 1.6, trailAtr: 1.25 }`):

| Strategy | TF | Trades | WR% | Full R | OOS R | PF | Quarters + | Cost ×2 R |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| **PDH_PDL_CPR** (default + NIFTY) | 5m | 17 | 70.6% | **+0.627R** | **+1.156R** | 3.72 | **4/4** | **+0.131R** |
| **GAP_AND_GO** (1–4.5%, 1.6× + NIFTY) | 5m | 31 | 71.0% | **+0.343R** | **+0.298R** | 2.32 | 2/4 (Q1: 0 trades) | **+0.212R** |
| **GAP_AND_GO** (1–4.5%, 1.6×, no NIFTY) | 5m | 60 | 58.3% | +0.149R | +0.076R | 1.50 | 2/4 | +0.020R |
| ORB_SUPERTREND_15M | 15m | 268 | 44.8% | −0.049R | −0.054R | 0.90 | 1/4 | −0.266R |
| ORB_SUPERTREND | 5m | 136 | 41.2% | −0.187R | −0.133R | 0.75 | 1/4 | −0.456R |
| TECHNICAL_COMPOSITE | 5m | 64 | 43.8% | −0.040R | −0.014R | 1.01 | 2/4 | −0.316R |
| PDH_PDL_CPR_15M | 15m | 117 | 47.0% | −0.022R | −0.177R | 0.99 | 3/4 | −0.236R |
| BB_SQUEEZE_BREAKOUT | 5m | 22 | 36.4% | −0.352R | −0.046R | 0.58 | 1/4 | −0.730R |
| SMC_STRUCTURE_15M | 15m | 121 | 33.9% | −0.235R | −0.122R | 0.45 | 0/4 | −0.420R |
| EMA_CROSS_9_21_15M | 15m | 38 | 28.9% | −0.257R | −0.212R | 0.49 | 0/4 | −0.412R |
| FAILED_BREAKOUT_TRAP | 5m | 439 | 40.5% | −0.215R | −0.174R | 0.68 | 0/4 | −0.448R |
| VWAP_PULLBACK | 5m | 459 | 38.1% | −0.262R | −0.177R | 0.57 | 0/4 | −0.538R |

### Recommendation
1. **Retire legacy 5-min `@v1` trend versions** (migration `0007_retire_failing_intraday_v1.sql`) and keep the engine in **PAPER** during soak validation.
2. **Focus paper validation on `PDH_PDL_CPR` (`5m` + NIFTY alignment)** and **`GAP_AND_GO` (`1.0–4.5%`, `1.6×` opening RVOL)**: both stayed positive in-sample, out-of-sample, and under **2× cost stress** (`PDH_PDL_CPR` passed `4/4` quarters; tuned `GAP_AND_GO` passed 5/6 gates with `18/18` parameter stability and missed only `WALK_FORWARD` because Q1 had zero qualifying days).
3. **Continue expanding 24-stock live-parity `ResearchLab` sweeps** with `15m` and swing strategies; only promote to LIVE if a candidate clears all 6 validation gates and paper execution matches backtest slippage.
4. Add capital only after a strategy is positive after charges in most quarters **and** in paper trading. More capital doesn't create an edge: charges are mostly a percentage of each trade.

---

## 10. Where it lives in the code

| Part | File |
|---|---|
| Auto-pick movers | `packages/strategy/src/screener.ts` (`pickUniverse`), `apps/engine/src/main.ts` (`refreshAutoUniverse`) |
| Strategies | `packages/strategy/src/strategies/*.ts`, `intraday.ts`, `swing.ts`, registry in `catalog.ts` |
| Ensemble / quality | `packages/strategy/src/ensemble.ts` |
| 15-min trend, NIFTY direction, relative strength | `packages/strategy/src/bias.ts` |
| Stop clusters (stop-hunt guard) | `packages/strategy/src/liquidity.ts` |
| Entry rules | `apps/engine/src/live.ts` (`decide`, `LiveAnalyzer`) |
| AI review | `packages/ai/src/reviewer.ts`, `consensus.ts` |
| Sizing | `packages/risk/src/sizing.ts`, `apps/engine/src/main.ts` (`enterEquity`, `fitToFunds`) |
| Orders (GTT bracket) | `packages/broker/src/upstox.ts` |
| Exits, square-off | `apps/engine/src/trader.ts` (`manage`) |
| Circuit breakers, session times | `packages/safety/src/breakers.ts`, `packages/core/src/clock.ts` |
| Backtester | `packages/backtest/src/engine.ts` |
