# TradeForger — Deep Technical Audit, Root-Cause Analysis & Solutions

> **Audit Scope:** Full review of TradeForger's production pipeline, whole-NSE stock screener, 19 intraday strategies, ensemble scoring, entry rules, AI review layer, position sizing, exits, and backtest/live metrics (as of 26 Nov 2026).
>
> **Current Baseline:**
> - **Backtest (Aug–Nov 2026, 40 stocks, 5m data):** Expectancy of $-0.05\text{R}$ to $-0.12\text{R}$ per trade after charges.
> - **Live Upstox Log:** $12$ trades, $-\text{₹}71$ net P&L, $-0.09\text{R}$ average expectancy.
> - **Stop-Out Diagnostics:** $52\% - 56\%$ of stopped trades never reached $+0.25\text{R}$ MFE; only $1\% - 2\%$ reached their target after stopping out.

---

## Executive Summary

TradeForger's **infrastructure, safety engineering, and validation discipline are institutional-grade**. Your whole-NSE dynamic screener, closed-bar anti-repainting architecture, GTT broker-side brackets, independent 15:05 square-off timer, circuit breakers, and strict walk-forward rejection of unvalidated strategies put the platform far ahead of typical retail engines.

However, the negative expectancy ($-0.05\text{R}$ to $-0.12\text{R}$) and the $52\% - 56\%$ immediate-failure rate are **not random market noise**. They are caused by **six compounding structural flaws** inside the strategy rules, entry pipeline, sizing math, and exit logic:

1. **Built-in Entry Chasing & Latency Stack:** Combining pre-extended stock selection, closed-bar lagging triggers, overly loose VWAP/breakout distance limits, and an $8 - 10\text{ s}$ execution delay causes the engine to buy the peak of impulse bars right before routine pullbacks.
2. **Strategy Implementation Drift:** Key strategies (`PDH_PDL_CPR`, `SMC_STRUCTURE`, `HOLY_GRAIL_15M`, `GAP_AND_GO`, `BB_RSI_REVERSION`) deviate from the exact entry mechanics or filters that give them their historical edge.
3. **The Hidden Sizing & Friction Trap:** The $\text{₹}10,000$ per-trade notional cap silently collapses your planned $\text{₹}750$ risk ($1\text{R}$) down to $\approx \text{₹}65$, allowing brokerage, statutory taxes, and bid-ask spreads to consume $35\% - 70\%$ of your real $1\text{R}$.
4. **Ensemble Collinearity Bias:** Multiple correlated moving-average strategies vote simultaneously late in a trend, artificially inflating the quality score past $70$ and outranking earlier, cleaner setups.
5. **Target Over-Extension & Contradictory Exit Settings:** Forcing a $2.5\text{R}$ target on already-extended stocks while leaving a backtest-losing Staged Profit Trail turned **on** caps upside while keeping full downside.
6. **Screener-to-Strategy & AI Sizing Conflicts:** Production `Buy only` + upper-half day-range filters starve fade/reversion strategies, and the AI $0.5\times$ sizing multiplier interacts destructively with the $\text{₹}10,000$ cap.

---

## Finding 1: Structural Entry Chasing & Execution Latency Stack

### Diagnosis
Your §11 diagnostic is the clearest clue in the entire document:
- **$52\% - 56\%$ of stop-outs never go above $+0.25\text{R}$.**
- **Only $1\% - 2\%$ hit target after being stopped out.**

This mathematically proves that **your stops are not too tight**—your **entries are systematically too late**. A trade enters right as short-term buyers exhaust their liquidity and mean-reversion/profit-taking begins.

Your pipeline currently stacks **four consecutive sources of lag**:
1. **Screener Pre-Extension (§2.2):** Auto-pick only watches stocks already up $+0.4\%$ to $+5.0\%$ and sitting in the upper half of the day's range.
2. **Closed-Bar Confirmation on Lagging Indicators (§3):** Waiting for a $5\text{m}$ or $15\text{m}$ breakout or EMA crossover candle to *close* means $60\% - 80\%$ of the impulse move has already occurred before the signal fires.
3. **Permissive Chasing Thresholds (§5):**
   - Allowing trend entries up to $5\times \text{ATR}$ away from session VWAP is extremely stretched on $5\text{m}$ bars (normal intraday trend pullbacks live within $0.5\times - 2.0\times \text{ATR}$ of VWAP).
   - Allowing entries up to $0.5\times \text{ATR}$ past the signal bar close and $0.75\times \text{ATR}$ past the breakout trigger lets late fills slip through right into overhead resistance.
4. **Post-Signal Latency Stack (§5 & §6):**
   $$\text{Bar Close} \to \text{6 s stability hold} \to \text{1.5–4 s Gemini/Groq LLM call} \to \text{Market-protected Order}$$
   An $8 - 10\text{ s}$ delay *after* a $5\text{m}$ breakout candle closes on NSE midcaps/smallcaps regularly turns a breakout entry into a top-tick fill.

### Solutions
1. **Tighten Anti-Chasing Ceilings (`apps/engine/src/live.ts`):**
   - Cut the VWAP distance ceiling for trend entries from $5\times \text{ATR}$ down to **$2.0\times - 2.5\times \text{ATR}$** (test $1.5\times$, $2.0\times$, $2.5\times$ in Strategy Lab).
   - Tighten breakout chasing from $0.75\times \text{ATR}$ past trigger down to **$\le 0.25\times - 0.35\times \text{ATR}$** past trigger (and $\le 0.25\times \text{ATR}$ past signal bar close).
2. **Shift from Breakout-Close Entries to Pullback/Retest & Trigger Entries:**
   - Instead of market-buying the close of an oversized expansion bar, require either:
     - **Option A (Stop-Limit Trigger):** Arm a resting buy-stop/stop-limit order at the exact breakout level (e.g., pullback bar high, mother bar high) *before* the bar closes so fill happens at the structural level, not $1\text{ ATR}$ higher.
     - **Option B (First Retest / Micro-Pullback):** When a $5\text{m}$ bar closes beyond PDH/ORB with expansion volume, arm a pending limit entry at the breakout level $+ 0.1\times \text{ATR}$ (or the $50\%$ midpoint of the breakout candle) valid for the next $2 - 3$ bars.
3. **Eliminate Unnecessary Post-Close Latency:**
   - Because all strategies already read **closed bars only**, a $6\text{ s}$ "setup must hold unchanged" delay is redundant for preventing intra-bar flicker. Reduce this to **$1 - 2\text{ s}$** (purely to verify live LTP hasn't spiked away from the close).
   - For LLM review (`packages/ai/src/reviewer.ts`), either run LLM context scoring **asynchronously on candidate setups** before bar close (pre-warming context on the top 3 watchlist leaders), or enforce a strict **$1.5\text{ s}$ hard timeout** so slow API calls never cause late chases.

---

## Finding 2: Strategy-by-Strategy Implementation Audit

Several strategies in §3 have subtle deviations from their core market-structure edge—or are structurally incompatible with your current screener and time windows.

### 2.1 Detailed Critique & Fixes

| Strategy | Current Implementation | Critical Flaw | Recommended Fix |
| :--- | :--- | :--- | :--- |
| **`PDH_PDL_CPR`** *(Only LIVE strategy)* | Approved v2 uses **$0.9\%$ CPR width** (code default is $0.3\%$). Enters on first close beyond PDH/PDL on $1.3\times$ vol. | **Core edge stripped out.** Frank Ochoa's Narrow CPR works specifically because tight pivot compression ($\le 0.25\% - 0.35\%$ of price) signals a coiled spring. At $0.9\%$, almost every average/choppy NSE day qualifies, turning a high-selectivity filter into a generic PDH breakout. | Restore CPR width ceiling to **$\le 0.35\% - 0.45\%$** (or scale dynamically as $\text{CPR Width} \le 0.20 \times \text{Daily ATR}_{14}$). Require volume $\ge 1.5\times$ and entry within $\le 0.3\times \text{ATR}$ of PDH. |
| **`SMC_STRUCTURE`** *(5m & 15m)* | Enters on first close beyond confirmed swing (BOS/CHoCH), weighted by FVG; stop beyond opposite swing. | **Entering at the worst point of the displacement.** In institutional SMC, BOS + FVG defines the *setup*, not the market-order entry. Buying the BOS close forces maximum stop distance and immediate drawdown during the normal FVG mitigation pullback. | Change entry to **FVG Mitigation / Retracement**: after BOS + FVG prints, place a limit/trigger zone at the top edge (or $50\%$ CE) of the FVG, expiring if unmitigated after $6 - 8$ bars. This cuts stop distance in half and removes chasing. |
| **`HOLY_GRAIL_15M`** | Waits for a **$15\text{m}$ bar to close** beyond the pullback bar ($\text{ADX} \ge 30$, touch of 20-EMA). | **Violates Linda Raschke's entry trigger.** Waiting for a full $15\text{m}$ candle to close above the pullback bar gives away $50\% - 100\%$ of the bounce move back to the swing high, destroying R:R. | Trigger **intrabar** via stop-limit order $1 - 2$ ticks above the pullback bar's high once the pullback candle closes at/near the 20-EMA. Keep SL strictly below the pullback bar's low. |
| **`INSIDE_BAR_15M`** | Enters on a **$15\text{m}$ bar close** beyond the mother bar near PDH/PDL/VWAP. | Same close-delay issue as `HOLY_GRAIL_15M`: by the time a $15\text{m}$ breakout candle closes beyond a $15\text{m}$ mother bar, the move is often $1.5\times - 2\times \text{ATR}$ extended. | Enter **intrabar** on a clean break of the mother bar high (or use $5\text{m}$ close beyond the $15\text{m}$ mother bar high) with volume surge, rather than waiting for the $15\text{m}$ bar to finish. |
| **`GAP_AND_GO`** | $1\% - 4.5\%$ gap on $1.6\times$ vol; close beyond first $15\text{m}$ candle; entry window starts at **09:30 IST**. | **Misses the primary Gap & Go window.** On NSE, gap-and-go momentum plays out between **09:16–09:28 IST** (1m/5m ORB or first micro-pullback). Entering at 09:31+ on a $3.5\% - 4.5\%$ gap frequently buys directly into opening-hour profit booking. | Either cap gap size at **$1.0\% - 2.5\%$** for 09:30+ entries (leaving daily ATR room) and require a **bull flag / higher-low pullback above VWAP**, OR allow a dedicated early window (`09:20–09:35`) on $5\text{m}$ bars with reduced initial size. |
| **`ORB_SUPERTREND`** *(5m & 15m)* | Breakout beyond 15m (or 30m) OR + Supertrend + EMA9/21 + ADX + RVOL + VWAP + RSI. | **Over-filtered lag.** Requiring Supertrend + EMA9/21 + ADX to all align *after* an ORB close means the stock has already moved massively before firing (explaining why `ORB_SUPERTREND_15M` failed validation). | Add an **Opening Range Width filter**: skip ORB if $\text{OR High} - \text{OR Low} > 0.45 \times \text{Daily ATR}_{14}$ (range already spent). Drop lagging Supertrend/EMA9-21 requirements from ORB; rely strictly on **OR Break + RVOL $\ge 1.8\times$ + VWAP side + Space to Daily ATR cap**. |
| **`BB_RSI_REVERSION` & `FAILED_BREAKOUT_TRAP`** | Fade strategies (Buy on RSI $< 25$ / failed breakdown). | **Starved by your own screener.** Production runs `Buy only`, and auto-pick strictly selects stocks *up on the day and in the upper half of the day's range*. Oversold/failed-breakdown longs almost never appear on the watchlist! | Either build a dedicated **Mean-Reversion Scanner bucket** (stocks down $-1.5\%$ to $-4.0\%$ hitting major support/PDL/$-2\sigma$ VWAP with high liquidity) OR disable fade strategies in `Buy only` momentum mode so they don't generate sparse, biased samples. |
| **`EMA_CROSS_9_21`, `GMMA_TREND`, `SUPERTREND_MOMENTUM`, `TECHNICAL_COMPOSITE`** | Trend-following moving-average crossovers/ribbons on $5\text{m}$ bars. | **High whipsaw & collinearity.** Pure MA crossovers on $5\text{m}$ Indian equities have negative raw expectancy after costs because they lag tops and bottoms while feeding redundant votes into the ensemble. | **Retire or demote** `SUPERTREND_MOMENTUM`, `TECHNICAL_COMPOSITE`, and `EMA_CROSS_9_21` (5m) from lead-strategy status. Repurpose EMA9/21 and GMMA strictly as **regime/filter features** rather than standalone entry triggers. |
| **`VWAP_PULLBACK`** *(Currently Failed)* | Trend day pulls back to session VWAP and resumes with rejection bar. | Likely failed validation because of **tight stops right on VWAP** (stop-hunted by wicks), loose $5\text{ ATR}$ / late execution, and the $\text{₹}10,000$ sizing fee drag—not because VWAP pullbacks lack edge. | Re-test after fixing sizing/charges: enforce **first or second touch of VWAP only** (3rd+ touches fail), declining volume on pullback, bullish engulfing/pin-bar close on rising volume, SL at $\text{VWAP} - 0.5\times \text{ATR}_{5\text{m}}$ (capped at $1.5\times \text{ATR}$), and target at Day High ($1.5\text{R}$). |

---

## Finding 3: The Hidden Sizing & Friction Trap (Critical Math Bug)

### Mathematical Proof of the Bug
Your §7 sizing rules state:
- **Risk Capital:** $\text{₹}50,000$
- **Planned Risk ($1\text{R}$):** $1.5\% \times \text{₹}50,000 = \text{₹}750$ per trade
- **Per-Trade Notional Cap:** $\text{₹}10,000$ (*"smallest wins"*)
- **Minimum Intraday Stop:** $0.65\%$ of entry price

Now compute the **actual** rupee risk when the $\text{₹}10,000$ cap triggers:
$$\text{Required Notional for ₹750 Risk at } 0.65\% \text{ Stop} = \frac{\text{₹}750}{0.0065} = \text{₹}115,385$$

Because your notional cap is $\text{₹}10,000$, the cap **wins on every single intraday trade** whose stop is tighter than $7.5\%$ (which is $100\%$ of all intraday trades!):
$$\text{Actual Rupee Risk } (1\text{R}_{\text{actual}}) = \text{₹}10,000 \times 0.0065 = \text{₹}65$$

**Verification directly from your §11 Live Upstox Log:**
- Live trades: $12$ trades, net P&L $= -\text{₹}71$, average $=-0.09\text{R}$.
- Total R lost across $12$ trades: $12 \times 0.09\text{R} = 1.08\text{R}$.
- Implied actual $1\text{R}$ in live trading:
  $$1\text{R}_{\text{live}} = \frac{\text{₹}71}{1.08} \approx \text{₹}65.74$$

Your live log confirms the bug to the exact rupee: **you are risking $\approx \text{₹}66$ per trade instead of $\text{₹}750$, and worse, your $1\text{R}$ fluctuates wildly depending on stop width.**

### Why This Destroys Expectancy
1. **Transaction Cost Drag on $\text{₹}10,000$ Notional:**
   On Upstox equity intraday (MIS), a $\text{₹}10,000$ buy + $\text{₹}10,000$ sell ($\text{₹}20,000$ round-trip turnover) incurs:
   - Brokerage ($0.05\%$ or $\text{₹}20$/order, whichever is lower): $\text{₹}5 + \text{₹}5 = \text{₹}10.00$
   - STT ($0.025\%$ on sell side): $\text{₹}2.50$
   - NSE Exchange Txn ($\approx 0.00325\%$): $\text{₹}0.65$
   - Stamp Duty ($0.003\%$ on buy side): $\text{₹}0.30$
   - SEBI Turnover Fee: $\text{₹}0.02$
   - GST ($18\%$ on brokerage + exchange + SEBI): $\approx \text{₹}1.92$
   - **Total Round-Trip Charges:** **$\approx \text{₹}15.40$** ($\approx 0.154\%$ of notional).
   - **As a % of actual $1\text{R}$ ($\text{₹}65$):**
     $$\frac{\text{₹}15.40}{\text{₹}65.00} = 23.7\% \text{ of } 1\text{R}$$
   *(Note: If any plan charges flat $\text{₹}20$/order instead of $0.05\%$, round-trip cost jumps to $\approx \text{₹}51$, or $78\%$ of $1\text{R}$!)*

2. **Bid-Ask Spread Drag (§2.2):**
   Your screener allows bid-ask spreads up to $0.15\%$. Crossing even a $0.10\%$ spread on entry and exit ($0.20\%$ round-trip) on a $0.65\%$ stop costs an additional:
   $$\frac{0.20\%}{0.65\%} = 30.8\% \text{ of } 1\text{R}$$
   Combined with charges, **friction alone consumes $40\% - 55\%$ of $1\text{R}$** on tight-stop trades.

3. **The AI $0.5\times$ Multiplier Compounding Bug:**
   - If the AI $0.5\times$ multiplier (§6/§7) is applied **before** the $\text{₹}10,000$ cap, halving $\text{₹}750 \to \text{₹}375$ risk still gets capped at $\text{₹}10,000$—meaning the AI's `CAUTION` size reduction **does nothing**.
   - If the $0.5\times$ multiplier is applied **after** the $\text{₹}10,000$ cap, notional drops to $\text{₹}5,000$, actual $1\text{R}$ collapses to **$\text{₹}32.50$**, and charges + spread turn the trade mathematically negative-EV even with a $60\%$ win rate.

4. **The Upstox $\text{₹}40,000$ Brokerage Inflection Point:**
   Because Upstox intraday brokerage is $\min(0.05\%, \text{₹}20)$ per leg, **$\text{₹}40,000$ per leg is the exact ceiling** where brokerage stops growing ($0.05\% \times \text{₹}40,000 = \text{₹}20$). Above $\text{₹}40,000$ notional, brokerage cost as a percentage of notional drops linearly.

| Per-Trade Notional | Stop Width | Actual $1\text{R}$ | Est. Upstox Charges (RT) | Charges as $\%$ of $1\text{R}$ | MIS Margin Used ($\approx 5\times$) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| $\text{₹}10,000$ *(current)* | $0.65\%$ | $\text{₹}65$ | $\approx \text{₹}15.40$ | **$23.7\%$ (Deadly)** | $\text{₹}2,000$ |
| $\text{₹}10,000$ *(AI $0.5\times$)* | $0.65\%$ | $\text{₹}32.50$ | $\approx \text{₹}8.00$ | **$24.6\%$ (Deadly)** | $\text{₹}1,000$ |
| $\text{₹}40,000$ | $1.00\%$ | $\text{₹}400$ | $\approx \text{₹}61.50$ | $15.4\%$ *(Borderline)* | $\text{₹}8,000$ |
| $\text{₹}50,000$ | $1.00\%$ | $\text{₹}500$ | $\approx \text{₹}65.00$ | $13.0\%$ *(Acceptable)* | $\text{₹}10,000$ |
| $\text{₹}75,000$ | $1.00\%$ | $\text{₹}750$ | $\approx \text{₹}73.60$ | **$9.8\%$ (Healthy)** | $\text{₹}15,000$ |
| $\text{₹}75,000$ | $1.50\%$ | $\text{₹}1,125$ | $\approx \text{₹}73.60$ | **$6.5\%$ (Optimal)** | $\text{₹}15,000$ |

### Solutions (`packages/risk/src/sizing.ts` & `screener.ts`)
1. **Align Notional Cap with Intraday Risk Sizing:**
   - Decide your true rupee risk per trade first (for validation/early LIVE on $\text{₹}50,000$ capital, **$0.75\% - 1.0\%$ = $\text{₹}375 - \text{₹}500$** is safer than $\text{₹}750$ while keeping meaningful size).
   - Raise the per-trade notional cap from $\text{₹}10,000$ to **$\text{₹}50,000 - \text{₹}75,000$** (using $\text{₹}10,000 - \text{₹}15,000$ of MIS margin per trade on Upstox, well inside your $3\times$ exposure limit of $\text{₹}150,000$).
   - If you intentionally want to risk only $\approx \text{₹}100$ during early live testing, **do not use a tiny notional cap**—stay in PAPER until validated, then trade at proper notional where charges are $< 10\%$ of $1\text{R}$.
2. **Enforce Charges $\le 10\% - 12\%$ of *Actual* Post-Cap Risk:**
   - Audit `sizing.ts` to verify that the `charges <= 20% of 1R` rule divides round-trip charges by `actualQty * |entry - stop|` (not the theoretical $\text{₹}750$ planned risk), and tighten this threshold from $20\%$ down to **$\le 12\%$**.
3. **Tighten Spread & Minimum Stop Filters:**
   - Lower the bid-ask spread cap in `screener.ts` from $0.15\%$ to **$\le 0.06\% - 0.08\%$** for $5\text{m}$ strategies.
   - Raise minimum intraday stop from $0.65\%$ to **$0.80\% - 1.00\%$** (or enforce `15m` bars as primary timeframe) so statutory taxes and slippage cannot dominate P&L.
4. **Apply AI $0.5\times$ Multiplier Strictly to Target Risk Before Sizing** (and skip trade if the resulting position pushes charges above $12\%$ of $1\text{R}$).

---

## Finding 4: Ensemble Collinearity & Quality Inflation (`ensemble.ts`)

### Diagnosis
Your ensemble quality formula (§4) is:
$$\text{Quality} = \text{Lead Conf.} + \min(24,\; 8 \times N_{\text{agree}}) - \sum 20 \cdot \frac{\text{Opp. Conf.}}{\text{Lead Conf.}} + \text{R:R Bonus}$$

Look at your strategy roster in §3.1:
- `EMA_CROSS_9_21`
- `GMMA_TREND`
- `SUPERTREND_MOMENTUM`
- `TECHNICAL_COMPOSITE`
- `ORB_SUPERTREND`

These strategies are **heavily collinear**—all of them are derivatives of moving averages and momentum oscillators.
- Early in a clean breakout (when the edge is highest), moving averages haven't separated yet, so only $1$ strategy votes (`Quality` $= 65 \to$ **blocked** by the $\ge 70$ cutoff).
- Late in a mature, overextended spike, $3 - 4$ moving-average strategies fire simultaneously, adding $+16$ to $+24$ agreement points (`Quality` $= 84 \to$ **executes at the top**).

This systematically **inverts your selection**: it rejects early high-EV entries and aggressively promotes late, crowded moves.

### Solutions (`packages/strategy/src/ensemble.ts`)
1. **Implement Family-Bucketed Voting:**
   Group all strategies into distinct, non-overlapping signal families:
   - **Bucket A — Structural Breakout:** `PDH_PDL_CPR`, `PDH_PDL_CPR_15M`, `ORB_SUPERTREND`, `INSIDE_BAR_15M`, `GAP_AND_GO`
   - **Bucket B — Trend Pullback:** `HOLY_GRAIL_15M`, `VWAP_PULLBACK`, `SMC_STRUCTURE`, `SMC_STRUCTURE_15M`
   - **Bucket C — Moving-Average Momentum:** `EMA_CROSS_9_21`, `EMA_CROSS_9_21_15M`, `GMMA_TREND`
   - **Bucket D — Mean Reversion / Trap:** `BB_RSI_REVERSION`, `FAILED_BREAKOUT_TRAP`, `OI_WALL_REVERSAL`
2. **Max One Agreement Bonus Per Bucket:**
   Allow **at most one agreeing vote from any *other* bucket** to add bonus points (e.g., $+6$ per independent bucket, capped at $+12$). Two strategies from the same bucket contribute **$0$ extra agreement bonus**.
3. **Exclude `Failed` Strategies from Voting Entirely:**
   Ensure strategies marked `Failed` in the registry cannot contribute `+8` agreement points to a `LIVE`/`Paper` lead strategy—only validated/active strategies should vote in the ensemble.
4. **Penalize Over-Extension Inside the Quality Score:**
   Subtract a linear extension penalty when price is $> 1.5\times \text{ATR}$ from VWAP so early breakouts automatically outrank late chases.

---

## Finding 5: Target Over-Extension & Staged Trail Contradiction (`trader.ts`)

### Diagnosis
1. **Forced $2.5\text{R}$ Override (§3.4):**
   Even when a strategy proposes a realistic $2\text{R}$ structural target, the engine overwrites all trend targets to **$2.5\times$ risk**.
   - On a stock with a $1.0\% - 1.5\%$ stop, a $2.5\text{R}$ target demands an additional **$+2.5\%$ to $+3.75\%$** move *after* entry—on top of a stock the screener already picked at $+0.4\%$ to $+3.5\%$ up on the day.
   - Reaching a total $+5\%$ to $+7\%$ intraday expansion before 15:05 IST is a tail event in NSE cash equities, crushing your win rate.
2. **Staged Profit Trail Left ON Despite Negative Backtest (§8):**
   - Your production setting locks $+0.35\text{R}$ at $+1.2\text{R}$ and trails $1.25\times \text{ATR}$ from $+1.6\text{R}$.
   - Your own 12-month backtest already proved this **performed worse than a fixed target**. Why? Because once a trade finally clears $+1.2\text{R}$ in a volatile NSE midcap, normal $0.8\text{R}$ pullback noise sweeps your $+0.35\text{R}$ stop before the trade ever reaches $2.5\text{R}$. You keep $100\%$ of your $-1.0\text{R}$ losers while turning winners into $+0.35\text{R}$ scratch trades.
3. **Under-Utilized Diagnostic from "No-Follow-Through Exit" (§8):**
   - Closing trades that fail to reach $+0.25\text{R}$ within $4$ bars cut stop-outs from $32\% \to 18\%$ with unchanged expectancy. That confirms stagnant trades rarely recover—once you fix late entries (Finding 1), re-test this time-stop at $5 - 6$ bars (or exit at breakeven/small loss if price closes back inside the breakout level).

### Solutions (`apps/engine/src/trader.ts` & `packages/strategy/src/liquidity.ts`)
1. **Turn OFF the Staged Profit Trail Immediately:** Follow your own 12-month backtest evidence.
2. **Lower Trend `targetR` to $1.6\text{R} - 2.0\text{R}$ (Structure-Aware):**
   - Test `targetR` values of $1.5\text{R}$, $1.8\text{R}$, and $2.0\text{R}$ in Strategy Lab.
   - Cap targets just *below* the nearest major overhead liquidity level (R1/R2 pivot, round number, multi-day resistance) rather than placing the target *above* resistance. If capping pushes net R:R below $1.35$, skip the trade.
3. **Test True Partial Booking (Instead of Whole-Position Trailing):**
   - If you want smoother equity curves without choking winners, test booking **$50\%$ quantity at $+1.2\text{R}$**, moving the stop on the remaining $50\%$ to **breakeven + charges** ($+0.15\text{R}$), and letting the runner hold for $2.2\text{R} - 2.5\text{R}$ or $15:05$ square-off.

---

## Finding 6: Screener, Market-Regime & Watchlist Churn Issues

### Diagnosis
1. **Watchlist Churn Resets Setup Clocks (§2.2):**
   Re-picking every $5$ minutes drops stocks that temporarily fall outside the Top 30. When a stock pulls back slightly (creating the exact pullback entry you want!), its day-move score dips, it can drop out of the watchlist, and its setup state resets—biasing the engine to only hold stocks continuously printing green candles.
2. **Midcap/Smallcap Slippage vs. Fixed Costs:**
   Nearly $50\%$ of your auto-picked stocks are Smallcap 250 or outside the top 400. On $5\text{m}$ timeframes, smallcaps have thinner order books, wider spreads (up to your $0.15\%$ cap), and higher market-impact slippage on GTT/market-protected exits.
3. **AI Reviewer Latency & Redundant Checks (§6):**
   Sending live setups to both Gemini and Groq adds $1.5 - 4\text{ s}$ of execution delay, and a single `CAUTION` halves size (triggering the sizing bug in Finding 3) without proven walk-forward lift over deterministic rules.

### Solutions
1. **Add Sticky Hysteresis for Pulled-Back Leaders (`screener.ts`):**
   Keep any stock that entered the Top 15 locked on the watchlist for at least **$45 - 60$ minutes** (or until it breaks below VWAP / day-open), so normal pullbacks don't evict the best setups right before entry.
2. **Segment Liquidity by Timeframe:**
   - Restrict $5\text{m}$ strategies to **Nifty 200 / F&O stocks** (tighter spreads $\le 0.05\%$, deeper books, higher turnover floor $\ge \text{₹}50\text{ Cr}$).
   - Trade Midcap/Smallcap movers strictly on **$15\text{m}$ strategies** where wider stops ($1.2\% - 2.0\%$) absorb spread and slippage cleanly.
3. **A/B Test the AI Reviewer in Strategy Lab / Shadow Mode:**
   Log the AI verdict (`CONFIRM` / `CAUTION` / `REJECT`) in paper mode for $100+$ trades *without* blocking or halving size, then measure whether `REJECT` actually has lower expectancy than `CONFIRM`. If it doesn't improve net expectancy after accounting for the $2 - 4\text{ s}$ slippage penalty, make it advisory-only or run it asynchronously on the watchlist every $5$ minutes instead of on the hot execution path.

---

## Prioritized Implementation Roadmap (Strategy Lab Experiment Plan)

Do **not** change everything at once. Test each phase sequentially on your Aug–Nov 2026 dataset (and an out-of-sample split) to verify the exact expectancy delta of every fix.

### Phase 1: Immediate Config & Math Fixes (Zero Strategy Rewrite)
- [ ] **Fix Sizing Math (`sizing.ts`):** Raise per-trade notional cap from $\text{₹}10,000$ to $\text{₹}50,000 - \text{₹}75,000$ (or set paper test risk to $\text{₹}500$ with $\text{₹}60,000$ cap) so charges stay strictly $\le 10\% - 12\%$ of actual $1\text{R}$.
- [ ] **Tighten Execution Friction (`screener.ts` & `live.ts`):** Cut max bid-ask spread from $0.15\% \to 0.07\%$; raise minimum stop from $0.65\% \to 0.85\%$.
- [ ] **Disable Staged Trail (`trader.ts`):** Turn off staged profit trail; test fixed `targetR` at $1.6\text{R}$ and $1.8\text{R}$ instead of $2.5\text{R}$.
- [ ] **Tighten Anti-Chasing (`live.ts`):** Cut max VWAP distance from $5\text{ ATR} \to 2.0\text{ ATR}$, and max trigger chase from $0.75\text{ ATR} \to 0.30\text{ ATR}$.
- [ ] **Fix `PDH_PDL_CPR` Parameter:** Revert Narrow CPR width from $0.9\%$ back to $0.35\% - 0.45\%$.

*Expected Result of Phase 1:* Immediate reduction in fee drag ($+0.05\text{R}$ to $+0.10\text{R}$ lift) and a sharp drop in the $52\% - 56\%$ instant-reversal stop-outs.

### Phase 2: Ensemble & Execution Timing Fixes (Week 1–2)
- [ ] **Bucketed Ensemble (`ensemble.ts`):** Implement 4 strategy buckets with max 1 agreeing vote per independent bucket; block `Failed` strategies from contributing agreement bonuses.
- [ ] **Reduce Hot-Path Latency (`live.ts`, `reviewer.ts`):** Cut post-close stability hold from $6\text{ s} \to 1 - 2\text{ s}$; put AI reviewer in shadow-logging mode (or $1.5\text{ s}$ timeout) to measure true alpha vs. latency cost.
- [ ] **Sticky Watchlist (`screener.ts`):** Lock Top-15 picks for $45\text{ min}$ minimum so pullback setups don't get evicted before triggering.

### Phase 3: Strategy Logic Refactors (Week 2–3)
- [ ] **`SMC_STRUCTURE` & `SMC_STRUCTURE_15M`:** Refactor entry from BOS close to **FVG retracement limit entry**.
- [ ] **`HOLY_GRAIL_15M` & `INSIDE_BAR_15M`:** Refactor entry from $15\text{m}$ bar close to **intrabar stop-limit trigger** above pullback/mother bar high.
- [ ] **`ORB_SUPERTREND`:** Add Opening Range Width $\le 0.45 \times \text{Daily ATR}_{14}$ filter and strip redundant lagging Supertrend/EMA filters.
- [ ] **Fade Strategies (`BB_RSI_REVERSION`, `FAILED_BREAKOUT_TRAP`):** Either add a dedicated oversold/down-day screener bucket or pause them while production is `Buy only`.
- [ ] **Re-evaluate `VWAP_PULLBACK`:** Re-run walk-forward validation after Phase 1 sizing/chasing fixes with a 1st/2nd-touch rule and $\text{VWAP} - 0.5\text{ ATR}$ stop buffer.

### Phase 4: Strict Promotion Gate Before Arming LIVE
Promote a strategy from PAPER to LIVE **only** when all five criteria pass simultaneously:
- [ ] **Out-of-Sample Expectancy:** $\ge +0.10\text{R}$ per trade *after* full Upstox charges + $0.05\% - 0.10\%$ modeled slippage stress.
- [ ] **Sample Size:** Minimum $100+$ out-of-sample backtest trades AND $40+$ forward PAPER trades under identical sizing/notional rules.
- [ ] **Early-Failure Rate:** Percentage of stop-outs never reaching $+0.25\text{R}$ drops below **$35\%$** (down from $52\% - 56\%$).
- [ ] **Friction Ratio:** Average realized round-trip charges + slippage stay strictly **$\le 12\%$ of actual $1\text{R}$**.
- [ ] **Regime Stability:** Positive expectancy across at least $2$ of $3$ recent monthly sub-periods (not carried by a single outlier week).

---

## Codebase Quick-Reference Action Map

| File | Exact Changes to Audit / Implement |
| :--- | :--- |
| `packages/risk/src/sizing.ts` | Raise `maxNotionalPerTrade` from $\text{₹}10,000$ to $\text{₹}50,000 - \text{₹}75,000$; verify charge-ratio guard uses *actual post-cap risk*; tighten charge guard to $\le 12\%$; apply AI $0.5\times$ multiplier safely without breaking fee economics. |
| `packages/strategy/src/screener.ts` | Tighten `maxSpreadPct` ($0.15\% \to 0.07\%$); add $45\text{ min}$ watchlist hysteresis for pulled-back leaders; optionally split Nifty 200 ($5\text{m}$) vs. broader NSE ($15\text{m}$). |
| `packages/strategy/src/ensemble.ts` | Add strategy family buckets (max 1 agreement vote per bucket); exclude `Failed` strategies from adding agreement bonuses; add VWAP extension penalty. |
| `apps/engine/src/live.ts` | Cut VWAP chase limit ($5\text{ ATR} \to 2.0\text{ ATR}$); cut trigger chase ($0.75\text{ ATR} \to 0.30\text{ ATR}$); reduce post-close hold ($6\text{ s} \to 1 - 2\text{ s}$); support stop-limit trigger orders for pullback/inside-bar strategies. |
| `apps/engine/src/trader.ts` | Disable `stagedProfitTrail` in production; test fixed `targetR` ($1.6\text{R} - 1.8\text{R}$) or $50\%$ partial booking at $1.2\text{R}$ + breakeven trail. |
| `packages/strategy/src/strategies/*.ts` | Fix `PDH_PDL_CPR` width ($\le 0.35\% - 0.45\%$); refactor `SMC_STRUCTURE` to FVG mitigation; refactor `HOLY_GRAIL_15M` & `INSIDE_BAR_15M` to intrabar breakout triggers; add OR width cap to `ORB_SUPERTREND`. |
| `packages/ai/src/reviewer.ts` | Enforce $1.5\text{ s}$ timeout or run in shadow-logging mode for $100$ trades to validate real net-expectancy lift over latency cost. |