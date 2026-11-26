# TradeForger — How Automated Trading Works

> **Current reference:** [STRATEGIES-AND-STOCK-SELECTION.md](STRATEGIES-AND-STOCK-SELECTION.md) — this file keeps the research history and backtest results.

How the engine picks stocks, finds setups, decides to enter, sizes and places
orders, and exits. Every number here is what the code uses. Settings marked
**(AutoPilot)** can be changed on the dashboard.

> **Status (25 Nov 2026).** Sections marked **[deployed]** run on the server
> now. Sections marked **[ready, not deployed]** are built and tested, waiting
> for deployment (live engine disarmed to `PAPER` for new entries while open
> Upstox brackets remain managed).
>
> **Honest summary (26 Nov 2026):** no intraday strategy has a proven edge
> after charges. On 12 months of real data (Nov 2025 – Nov 2026) every rule
> set tested lost money; on a second, **unseen** year (Nov 2024 – Nov 2025) the
> tuned `PDH_PDL_CPR v2` and `ORB_SUPERTREND_15M v2` also lost (−0.24R and
> −0.13R a trade). The positive figures in §9 for small samples (17–60 trades)
> were measured on the same year their settings were tuned on and did not hold
> out of sample. Since migration `0007` no intraday strategy is APPROVED, so
> **LIVE takes no intraday trades by design**; run in PAPER to collect forward
> results. See §10.

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
| With the NIFTY | Longs only when NIFTY's 15-min EMA20 > EMA50; shorts on the mirror (AutoPilot). The "above today's open" condition is now an option, off: Aug–Nov 2026 it was the main source of "no clear direction" and did worse in both halves (−0.491R/−0.071R a trade vs −0.283R/−0.061R, real backtester, production settings) |
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
- **3R targets with a daily-range cap:** trend targets at **3×** risk (AutoPilot `targetR`), capped at today's open ± **1.5×** the prior 14-day daily ATR (`maxTargetDailyAtr`); a setup whose cap is already behind the price is invalid. 12 months: 3R + cap −0.131R a trade, 2.5R + cap −0.141R, 2R + cap −0.145R.
- **Staged trailing stop: off** (`stagedTrail`). It did worse than the fixed target over 12 months (−0.150R vs −0.141R), ratchets on ticks live where the test used closes, and its stop is held only in engine memory, so a restart drops it.

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

## 10. Why recent trades hit their stops, and why LIVE is not trading (26 Nov 2026)

### Live trades, 23 and 25 Nov (bar by bar on real candles)
| Cause | Trades |
|---|---|
| Stopped by a **wick** that closed back on the safe side | TATAMOTORS 09:33 (later hit its target), PNB, ICICILIFE, HDFCBANK |
| Gave back a large open profit | ICICILIFE (+1.45R), HDFCBANK (+1.67R), MARSONS, PFOCUS (+0.65R) |
| Chased a finished move | ICICILIFE (ran 7.8 ATR in 30 min before entry), PFOCUS (6 ATR past VWAP) |
| No follow-through at all | PNB, UNIONBANK, SWSOLAR, ITC (never above +0.4R) |

### 12 months, 2,950 backtest trades with the live rules
- 51% of trades stopped out. Of those, **52% never got above +0.25R**: the main cause is entries with no follow-through, not stop placement.
- 55% of stops were wicks, but only **7%** of stopped trades reached their target later that day. Close-confirmed stops lifted the win rate (35.9% → 39.0%) but not the result (−0.148R → −0.145R): **rejected**.
- Skipping entries after a 30-minute run over 3 ATR made it worse (−0.162R): **rejected**.
- Targets: lower multiples are worse, not better (table in §7). What keeps a target realistic is the daily-range cap, now on.

### Out-of-sample check of the v2 strategies (Nov 2024 – Nov 2025, never used for tuning)
| Strategy | Live-parity config | + NIFTY direction / relative strength |
|---|---|---|
| ORB_SUPERTREND_15M v2 | −0.13R, 114 trades, 1/4 quarters | +0.05R, 47 trades, 3/4 |
| PDH_PDL_CPR v2 | −0.24R, 138 trades, 1/4 | +0.01R, 51 trades, 2/4 |
| GAP_AND_GO | +0.06R, 39 trades, 2/4 | +0.02R, 19 trades, 2/4 |

None is a proven edge. Approving any for LIVE is your decision; the evidence does not support it yet.

### Learning from trades: a model trained on one year, judged on the other
A logistic-regression model learned, from 2,938 and 3,600 trades (Nov 2024 – Nov 2025 and Nov 2025 – Nov 2026), which entry conditions (strength vs NIFTY, day move, VWAP distance, 30-min run, stop width, volatility, time, 15-min trend, volume, strategy, side) predict a win.
| Trained on | Judged on (unseen) | All trades | Trades the model kept |
|---|---|---|---|
| 2024–25 | 2025–26 | −0.131R | −0.137R to −0.144R |
| 2025–26 | 2024–25 | −0.216R | −0.085R to −0.162R |

It looked profitable on its own training year and not on the other: these conditions do not separate winners from losers reliably. It is **not** used live.

Two conditions held in **both** years and are now rules:
| Rule | 2024–25 | 2025–26 |
|---|---|---|
| Current rules | −0.216R (2,938) | −0.131R (3,600) |
| + stop ≥ 1% of price, ≥ 0.5 daily ATR of range left (`minStopPct` 1, `minRoomDailyAtr` 0.5) | **−0.125R** (653) | **−0.032R** (960) |

Better in both years, still slightly negative, and no single strategy was positive in both years with a meaningful sample.

### Why LIVE takes no intraday trades
1. **No APPROVED intraday strategy** (migration `0007` retired the failing `@v1` approvals). `decide()` blocks every intraday setup with "has no APPROVED version (required in LIVE)". This is intended.
2. On top of that, normal filters block many setups: NIFTY direction (gap-up-then-fade mornings), chase > 0.5 ATR past the bar close, daily-range cap already passed, price band, quality < 70.

To trade again: run **PAPER** (CANDIDATE strategies trade there) and approve a strategy for LIVE only after its paper results confirm it.

---

## 11. Audit checklist review and changes (26 Nov 2026)

`autonomous_intraday_trading_system_audit_checklist.md` was checked against the
code and its ideas tested on 3 months of 5-minute data (18 Aug – 25 Nov 2026,
40 NSE large/mid/small caps, live-parity rules), each half judged separately.

### What the stop-outs say (checklist §5)
| Baseline stop-outs | Share | Checklist reading |
|---|---|---|
| Never above +0.25R | **52–56%** | entries without follow-through: strategy/regime, not stops |
| Reached +1R before the stop | 3% | targets / partial booking are not the problem |
| Stopped, then hit the target later that day | 1–2% | stops are not too tight |

### Tested
| Change | Result | Decision |
|---|---|---|
| Inside bar at PDH/PDL/VWAP (15m), new | +0.19R, 28 trades, positive in both halves | **added** (`INSIDE_BAR_15M`, paper) |
| Holy Grail pullback (15m), new | −0.03R, 65 trades | **added** (`HOLY_GRAIL_15M`, paper) |
| 5-EMA alert candle (5m short / 15m long) | −0.10R, ~300 trades | not added |
| Narrow CPR 0.9% → 0.3% | PDH_PDL_CPR_15M: 95 trades −0.29R → 27 trades −0.12R | **default** (migration `0010`) |
| No-follow-through exit (4 bars, < +0.25R) | stop-outs 32% → 18%, expectancy unchanged | AutoPilot option, **off** |
| NIFTY 15-min ADX regime gate (≥ 20 trend, < 25 fades) | worse | not used live |
| Structure-aware targets | better one half, worse the other | not used live (`structureTarget`, backtester option) |
| Min stop 0.6% / 0.5% + 1.2 ATR / 1.5 ATR | more trades, no better | 1% kept |
| 2R targets | within noise | 3R kept |

Strategies still allowed to lead in PAPER, together: **−0.204R → −0.052R a trade**
(−41.5R → −11.8R total; stop-outs 32% → 24%), better in both halves
(−0.30 → −0.12R, −0.11 → 0.00R). Still not a proven edge.

### Also fixed
- A tight-stop vote the 1% minimum blocks no longer hides a wider-stop vote that would trade (`canLead`).
- Auto-picks skip bid-ask spreads over 0.15%, 2%/5% price-band stocks (surveillance, illiquid) and stocks within 1.5% of their circuit.
- The instrument master retries every 5 minutes after a failed boot download (it used to leave the day on the 11 default stocks).
- GMMA's 15-minute check used the forming bar; research datasets crashed on an undefined cache constant.

---

## 12. External audit review (Gemini, 26 Nov 2026)

`tradeforger_deep_technical_audit_solutions.md` was checked against the code
and its testable fixes backtested: 3 months (18 Aug – 25 Nov 2026), 40 stocks,
production settings, paper-eligible strategies, buy only, each half judged separately.

| Audit claim / fix | Finding | Result per trade (H1 / H2), production −0.274R / −0.056R | Decision |
|---|---|---|---|
| ₹10,000 cap shrinks 1R to ~₹65–100 | **True** (risk-based wants ₹75,000 at a 1% stop) | — | documented |
| Raise cap to ₹50–75k | lets tight-stop trades past the charges guard | −0.29 to −0.32 / −0.07 to −0.09; rupee loss 8–10× | **rejected** |
| AI 0.5× size "destroys fee economics" | **False**: brokerage is 0.05% below ₹40k/leg, so charges stay ~15% of 1R at any size | — | none |
| "₹71 / 1.08 = ₹65.74 proves the bug" | coincidence: live trades were sized from the small Upstox balance | — | none |
| Min stop 0.85% / 1.0% | | better / worse | not changed |
| Charges guard 12% | | +0.18 (23 trades) / −0.18 | not changed |
| VWAP chase 2.0 / 1.5 ATR | | better / worse | not changed |
| **VWAP chase 2.5 ATR + 2R target + staged trail off** | | **−0.268 / −0.005** (rupee loss −41%) | **applied** |
| Target 1.6R / 1.8R | | worse / worse | rejected |
| Failed strategies add +8 agreement | **True** — a logic bug | not backtestable (ensemble) | **fixed**: they no longer vote |
| 6 s entry hold is redundant on closed bars | true | not backtestable | **2 s** |
| CPR width 0.35–0.45% for PDH_PDL_CPR | 4 vs 8 trades — too few to judge | | approved v2 kept (owner's call) |
| Intrabar / FVG-retest / stop-order entries | architectural (resting trigger orders) | — | not done |
| Fade strategies starved by buy-only + up-day picks | true (0 trades) | — | noted |

---

## 12b. 20-month review (27 Nov 2026) — supersedes the 3-month conclusions above

Data: 5-minute bars, 10 Mar 2025 – 25 Nov 2026 (~420 sessions), 40 NSE stocks,
13 paper-eligible strategies, production rules, full charges, buy only. Four
periods: P1 Mar–Jul 2025, P2 Aug–Dec 2025, P3 Jan–May 2026, P4 Jun–Nov 2026.

| Variant | Trades | Per trade | Periods better than "26 Nov production" | Decision |
|---|---|---|---|---|
| 26 Nov production (VWAP 2.5, 2R, no trail, NIFTY EMA-only) | 2,631 | −0.226R | — | replaced |
| Previous settings (VWAP 5, 2.5R, staged trail on) | 2,794 | −0.213R | 3 of 4 | **restored** |
| NIFTY needs trend **and** above today's open | 1,654 | **−0.196R** | 3 of 4, half the rupee loss | **restored (default on)** |
| Retest entry, 0.25 ATR, 3 bars | 1,945 | −0.226R | 2 of 4 | option, **off** |
| Retest at breakout level / bar midpoint / 0.5 ATR | 1,302–1,375 | −0.231 to −0.257R | ≤ 2 of 4 | rejected |
| `HOLY_GRAIL_15M` | 606 | −0.258R | — | **failed** (migration 0012) |
| `INSIDE_BAR_15M` | 278 | −0.127R | — | **failed** (migration 0012) |
| `FAILED_BREAKOUT_TRAP` (fade) | 211 | −0.247R | — | no down-day scanner built for it |

`PDH_PDL_CPR` (5m, approved v2 at 0.9% CPR width): 22 trades −0.005R; at 0.45%
15 trades +0.118R; at 0.35% 14 trades +0.214R — narrower looks better but the
sample is tiny and every width lost in P4. `PDH_PDL_CPR_15M`: 0.35–0.45% beats
0.9% overall (−0.09R vs −0.11R); the code default is 0.3%.

Strategy Lab validation (the server's own gates: ≥ 30 trades, PF ≥ 1.1,
positive out-of-sample, ≥ 60% of walk-forward folds, parameter stability,
2× cost stress) run locally on the 20 months: `EMA_CROSS_9_21_15M` failed
(out-of-sample −0.270R, 43 trades) and `SMC_STRUCTURE_15M` failed (−0.123R,
102 trades). The remaining runs were stopped; none was approved.

**Production selection (27 Nov 2026):** AutoPilot trades only `GAP_AND_GO`,
`PDH_PDL_CPR` and `PDH_PDL_CPR_15M` — the three best 20-month records.

**Conclusion:** no intraday rule set here is profitable over 20 months. Keep
PAPER; approve nothing new for LIVE without a positive result across most of
these periods.

---

## 13. Where it lives in the code

| Part | File |
|---|---|
| Auto-pick movers | `packages/strategy/src/screener.ts` (`pickUniverse`), `apps/engine/src/main.ts` (`refreshAutoUniverse`) |
| Strategies | `packages/strategy/src/strategies/*.ts` (checklist additions in `professional.ts`), `intraday.ts`, `swing.ts`, registry in `catalog.ts` |
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
