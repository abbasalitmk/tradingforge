# Autonomous Intraday Trading System — Comprehensive Audit Checklist

> **Diagnostic Context:** When an automated intraday system consistently triggers Stop Losses (SL) while missing high targets, the root cause is typically one of three systemic flaws:
> 1. **Stop Losses placed inside normal intraday noise** (too tight relative to stock volatility).
> 2. **Targets set beyond realistic intraday range** (ignoring remaining Average True Range or overhead Support/Resistance).
> 3. **Regime mismatch** (deploying breakout/trend strategies during choppy, sideways sessions).

---

## 1. Stock Selection & Universe Expansion (Beyond Nifty 50)
Restricting scans to Nifty 50 limits the system to heavyweights that often move slowly or get pinned by index derivatives. Ensure your scanner dynamically evaluates the broader market while maintaining strict execution quality.

- [ ] **Broaden the Stock Universe:** Scan across **Nifty 500**, **NSE F&O**, and liquid **NSE Cash** stocks rather than only Nifty 50 to capture high-beta midcaps and active sector leaders.
- [ ] **Liquidity & Spread Guardrails:** Enforce minimum average daily turnover (e.g., $\ge \text{₹}50\text{ Cr}$), tight bid-ask spreads ($\le 0.05\% - 0.1\%$), and automatically exclude ASM/GSM, T2T, and circuit-bound stocks.
- [ ] **Relative Volume (RVOL) Filter:** Prioritize stocks trading with unusually high institutional participation ($\text{RVOL} \ge 1.5\times - 2.0\times$ compared to the 10-day or 20-day time-of-day average).
- [ ] **Pre-Market Gap & News/Catalyst Scan:** Identify stocks with clean pre-market gaps ($1\% - 5\%$) supported by pre-open volume confirmation.
- [ ] **Intraday Volatility (ATR%) Band:** Filter out dead/low-volatility stocks (where intraday range cannot cover brokerage, STT, and slippage) and extreme hyper-volatile stocks prone to violent whipsaws.
- [ ] **Relative Strength & Sector Alignment:** Rank stocks against both the benchmark index (Nifty 50) and their respective sectoral index (e.g., Nifty Bank, Nifty IT, Nifty Auto) to trade longs in the strongest sectors and shorts in the weakest.

---

## 2. Proven Intraday Strategies Used by Famous Traders & Prop Desks
Verify which of these battle-tested human and institutional strategies are implemented in your engine, along with their exact Entry, SL, and Target rules.

### A. Opening & Momentum Strategies
- [ ] **Opening Range Breakout / ORB (Toby Crabel):**
  - *Concept:* Captures early institutional order flow after the opening bell.
  - *Entry:* 5m or 15m candle close above/below the first 15-minute (9:15–9:30 AM) high/low with volume $> 1.5\times$ average. Skip if the opening range is already $> 50\%$ of Daily ATR.
  - *SL:* Opposite side of the opening range (or midpoint + ATR buffer if range is wide).
  - *Target:* $1.5\times$ to $2\times$ the opening range width, or trail using 9-EMA.
- [ ] **Gap & Go / Bull Flag Momentum (Ross Cameron / Warrior Trading):**
  - *Concept:* High-RVOL stocks gapping up on news/earnings that make a strong first leg and consolidate briefly.
  - *Entry:* First candle to make a new high after a 2–4 candle low-volume pullback (Bull Flag) above VWAP.
  - *SL:* Low of the pullback/flag consolidation.
  - *Target:* Scale out $50\%$ at $1:1.5$ or $1:2$, trail remainder below each 5m candle low or 9-EMA.
- [ ] **Second Day Play / In-Play Catalyst (SMB Capital / Mike Bellafiore):**
  - *Concept:* Stocks that had a massive news/earnings move yesterday often have institutional follow-through on Day 2.
  - *Entry:* Breakout above Previous Day High (PDH) or clean pullback to Day-2 VWAP.
  - *SL:* Below VWAP or recent 5m swing low.
  - *Target:* Multi-day key resistance levels or $2R$ with trailing stop.

### B. Trend-Following & Pullback Strategies
- [ ] **VWAP Pullback & Reclaim (Andrew Aziz / Institutional Prop Desks):**
  - *Concept:* Institutions benchmark execution against VWAP, making it dynamic intraday support/resistance.
  - *Entry:* Stock trends above VWAP, pulls back to touch VWAP on declining volume, and prints a bullish rejection/engulfing candle on rising volume.
  - *SL:* $0.5\times \text{ATR}$ below VWAP (not *right* on VWAP, where wicks hunt stops).
  - *Target:* Previous intraday high ($1R$), then trail for $2R+$.
- [ ] **The Holy Grail Pullback (Linda Raschke):**
  - *Concept:* High-probability trend continuation when ADX confirms a strong trend.
  - *Entry:* 14-period $\text{ADX} > 30$ (strong trend). Wait for price to retrace to the 20-EMA, then enter on a break of the pullback candle's high (for longs) or low (for shorts).
  - *SL:* Beyond the swing low/high of the pullback candle.
  - *Target:* Re-test of the recent swing extreme ($1R$), then trail.
- [ ] **ABCD Pattern (Andrew Aziz):**
  - *Concept:* Structured 3-leg intraday continuation (Impulse A→B, Pullback B→C holding above VWAP/support, Breakout C→D).
  - *Entry:* Break above point B (or early entry on higher low at C with volume confirmation).
  - *SL:* Below point C.
  - *Target:* Measured move equal to length of A→B.
- [ ] **9/21 EMA Slope & Crossover (45-Degree Trend Filter):**
  - *Concept:* Filters out flat, choppy moving average crossovers.
  - *Entry:* 9-EMA crosses above 21-EMA (or 5-EMA / 15-EMA) with both EMAs sloping steeply (avoid flat EMAs), confirmed by MACD above zero.
  - *SL:* Below 21-EMA or recent swing structure.
  - *Target:* $1:1.5$ to $1:2$ or exit on candle close below 9-EMA.

### C. Indian Market & Pivot Specialists
- [ ] **Narrow CPR Breakout & Virgin CPR Reversal (Frank Ochoa / Gomathi Shankar):**
  - *Concept:* Central Pivot Range (CPR) width predicts whether the day will be trending or sideways.
  - *Entry (Trending):* Narrow CPR (top and bottom pivots tightly compressed) → trade breakout above TC (Top Central) or below BC (Bottom Central) with volume.
  - *Entry (Sideways):* Wide CPR → fade bounces between Bottom CPR and Top CPR.
  - *SL:* Opposite side of the CPR zone.
  - *Target:* Standard Pivot R1/R2 (for longs) or S1/S2 (for shorts).
- [ ] **5-EMA Mean Reversion / Alert Candle (Popular Indian Retail Setup - Subasish Pani / Power of Stocks):**
  - *Concept:* Catches sharp intraday snaps when price overextends away from the 5-EMA.
  - *Entry (Short on 5m / Long on 15m):* Wait for a candle whose entire body + wick does not touch the 5-EMA ("alert candle"). Enter when the next candle breaks the low (for short) or high (for long) of the alert candle.
  - *SL:* High/low of the alert candle (capped by max ATR risk).
  - *Target:* Minimum $1:2$ or $1:3$ R:R, or trail aggressively.
- [ ] **PDH / PDL Rejection & Inside Bar Breakout (Price Action / Al Brooks):**
  - *Concept:* Previous Day High/Low act as major liquidity magnets.
  - *Entry:* Inside Bar (mother candle followed by smaller contained candle) near PDH/PDL or VWAP; enter on breakout of the mother candle with volume.
  - *SL:* Opposite end of the Inside Bar / Mother Candle.
  - *Target:* $1.5R - 2R$ or next major pivot level.

### D. Mean Reversion & Quantitative Strategies (Sideways Regimes)
- [ ] **VWAP $\pm 2\sigma$ / $\pm 3\sigma$ Standard Deviation Fade (Quant / Stat-Arb):**
  - *Concept:* In low-ADX sideways markets, extreme moves away from VWAP revert to the mean.
  - *Entry:* $\text{ADX} < 20$, price pierces $\pm 2\sigma$ VWAP band with RSI $> 75$ or $< 25$ and prints a reversal candle.
  - *SL:* Beyond $\pm 2.5\sigma$ or $1.5\times \text{ATR}$ beyond the reversal wick.
  - *Target:* Intraday VWAP (mean).
- [ ] **Bollinger Band + RSI Exhaustion (Larry Connors / Mean Reversion):**
  - *Concept:* Fading short-term exhaustion spikes.
  - *Entry:* Price closes outside 20-period, 2-SD Bollinger Band with 2-period RSI $< 10$ (long) or $> 90$ (short), followed by a close back inside the band.
  - *SL:* $1.5\times \text{ATR}$ beyond the extreme wick.
  - *Target:* Middle Bollinger Band (20-SMA).

---

## 3. Entry, Stop-Loss (SL) & Target Mechanics
This is the most critical section for resolving repeated SL hits and missed targets.

### Entry Precision
- [ ] **Confirmation Over Anticipation:** Require candle-close confirmation or volume-threshold confirmation rather than blind limit orders on touched le/vels.
- [ ] **Avoid Chasing Extended Moves:** Block entries if price is already extended too far from VWAP or 20-EMA (e.g., $> 1.5 \times \text{ATR}_{5\text{m}}$ away from the mean).
- [ ] **Market Regime Filter:** Use Nifty/Index trend and ADX ($\text{ADX} > 20 - 25$ for trending, $\text{ADX} < 20$ for sideways) to dynamically enable breakout strategies and disable mean-reversion (or vice versa).
- [ ] **Time-of-Day Filter:** Avoid fresh breakout entries during low-liquidity midday chop (typically 11:30 AM – 1:15 PM IST) and block new entries near market close.

### Stop-Loss (SL) Engineering
- [ ] **Volatility-Adjusted SL (ATR-Based):** Replace tight, fixed-percentage stops with dynamic stops scaled to volatility (e.g., $1.5\times$ to $2.0\times \text{ATR}$ on the execution timeframe) so normal market noise does not wick out positions.
- [ ] **Structure-Based SL + Buffer:** Place stops beyond logical market structure (recent swing high/low, VWAP, or breakout candle extreme) plus a small volatility buffer to avoid retail stop-hunting zones.
- [ ] **Dynamic Position Sizing:** Keep rupee risk constant regardless of SL width using:
  $$\text{Quantity} = \left\lfloor \frac{\text{Risk Per Trade (₹)}}{|\text{Entry Price} - \text{Stop Loss Price}|} \right\rfloor$$

### Target & Trade Management Engineering
- [ ] **ATR-Capped Realistic Targets:** Ensure the target distance does not exceed the stock's remaining realistic daily range (check how much of the 14-day Daily ATR has already been consumed).
- [ ] **Structure-Aware Targets:** Cap or adjust targets if a major resistance/support level (PDH/PDL, CPR, round numbers) sits before the calculated Reward-to-Risk ($R:R$) target.
- [ ] **Realistic Risk-to-Reward ($R:R$):** Target achievable intraday ratios ($1:1.5$ to $1:2.5$) instead of overly ambitious static targets that rarely fill before 3:15 PM.
- [ ] **Partial Profit Booking:** Book $50\%$ of the position at $1R$ or $1.5R$ to lock in realized gains and reduce equity volatility.
- [ ] **Breakeven & Trailing Stop Loss:** Move SL to breakeven (entry + estimated brokerage/taxes) once $1R$ is reached, and trail the remaining position using swing lows/highs, 9-EMA, SuperTrend, or VWAP.
- [ ] **Time-Based Exit & Auto Square-Off:** Exit stagnant trades that fail to move in your favor within $N$ candles (time stop), and auto-square off all positions safely before broker RMS cut-off (e.g., 3:05–3:15 PM IST).

---

## 4. AI Final Ranking Model & Risk Guardrails
An AI ranking layer should act as a strict quality filter, not just a signal generator.

- [ ] **Feasibility Features in the AI Model:** Feed the ranking model not just technical indicators, but **trade feasibility metrics**:
  - Distance to nearest Support/Resistance in ATR multiples.
  - Percentage of Daily ATR already used.
  - Current RVOL and bid-ask spread.
  - Sector relative strength and broader market regime score.
- [ ] **Probability / Confidence Thresholding:** Enforce a strict, backtested probability cutoff (e.g., only execute top $N$ signals scoring above $0.65+$). Reject marginal setups even if capital is idle.
- [ ] **Cross-Strategy Conflict Resolution:** Automatically veto trades if two internal strategies emit conflicting signals (e.g., a Momentum Buy and a Mean-Reversion Sell) on the same ticker simultaneously.
- [ ] **Overfitting & Live-Drift Monitoring:** Validate the AI model using **Walk-Forward Analysis** across distinct market regimes (bull, bear, sideways) rather than a single train/test split, and monitor live win-rate drift.
- [ ] **Realistic Cost Modeling:** Ensure all backtests and AI reward functions deduct realistic **slippage, STT, exchange transaction charges, GST, SEBI fees, and brokerage**.
- [ ] **Portfolio-Level Kill Switches:**
  - Max daily drawdown limit (e.g., stop trading for the day if realized + unrealized loss hits $2\% - 4\%$ of capital).
  - Max consecutive losses cooldown (e.g., pause after 3 consecutive losses).
  - Sector/correlation cap (avoid taking multiple simultaneous trades in the same sector).

---

## 5. Immediate Diagnostic Audit (Run on Your Last 30 Trades)
Before adding new strategies, export your last 20–30 losing trades and compute **MFE (Maximum Favorable Excursion)** and **MAE (Maximum Adverse Excursion)**:

- [ ] **High MFE before hitting SL:** If trades routinely reach $1R - 1.5R$ in profit before reversing to hit SL, your **targets are too wide** and you lack **partial booking / breakeven trailing**.
- [ ] **Immediate SL hit followed by target hit:** If trades hit SL within 1–3 candles and then rally to your original target, your **SL is too tight** (inside noise) or your **entry is chasing** an extended candle.
- [ ] **Zero MFE (Immediate reversal):** If trades immediately go against you and stay red, your **strategy-to-regime alignment** or **stock selection filters** need tightening.