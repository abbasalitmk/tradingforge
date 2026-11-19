/**
 * Approximate Indian retail transaction charges.
 *
 * Every percentage here is a percentage of TURNOVER (price x qty) in percent
 * units, i.e. `0.025` means 0.025% = 2.5 bps. The numbers are the published
 * NSE / SEBI / Upstox tariff as understood at the time of writing (FY2026-27)
 * and are deliberately rounded UP where there was doubt — a backtest that
 * under-charges is how a negative-expectancy strategy looks profitable.
 *
 * These are approximations for research. The engine can (and for anything
 * that matters, should) substitute the broker's own figure from
 * `POST /v2/charges/brokerage`, which returns the exact contract-note charges
 * for a given instrument, qty, price and product. A `CostModel` is just data,
 * so a calibrated model can be built from that endpoint and passed in.
 *
 * NOT modelled: DP charges on delivery sells (~₹18.5 + GST per scrip per day),
 * IPFT / clearing charges (fractions of a bp), and contract-note rounding of
 * STT/stamp to the nearest rupee. All are small, though DP charges are a
 * meaningful drag on very small delivery (swing) positions.
 */
export interface CostModel {
  readonly name: string;
  /** Flat brokerage per executed order, rupees. */
  brokeragePerOrder: number;
  /**
   * Percentage brokerage per executed order. Brokerage charged per order is
   * `min(brokeragePerOrder, brokeragePct% x order turnover)`. A value of 0
   * means "flat only" — brokerage is just `brokeragePerOrder`.
   */
  brokeragePct: number;
  /** Securities Transaction Tax on the buy leg's turnover. */
  sttBuyPct: number;
  /** Securities Transaction Tax on the sell leg's turnover. */
  sttSellPct: number;
  /** Exchange transaction charge, both legs. */
  exchangePct: number;
  /** SEBI turnover fee, both legs (₹10 per crore = 0.0001%). */
  sebiPct: number;
  /** Stamp duty, buy leg only. */
  stampBuyPct: number;
  /** GST, as a percentage of (brokerage + exchange charge + SEBI fee). */
  gstPct: number;
}

/**
 * NSE equity intraday (MIS).
 * - Brokerage: Upstox ₹20 or 0.05% per executed order, whichever is lower.
 * - STT: 0.025% on the sell side only.
 * - NSE transaction charge: 0.00297% (uniform rate since Oct 2024).
 * - SEBI: ₹10/crore = 0.0001%.
 * - Stamp: 0.003% on buy.
 * - GST: 18%.
 */
export const EQUITY_INTRADAY: CostModel = {
  name: 'EQUITY_INTRADAY',
  brokeragePerOrder: 20,
  brokeragePct: 0.05,
  sttBuyPct: 0,
  sttSellPct: 0.025,
  exchangePct: 0.00297,
  sebiPct: 0.0001,
  stampBuyPct: 0.003,
  gstPct: 18,
};

/**
 * NSE equity delivery (CNC) — what swing trades pay.
 * - Brokerage: Upstox ₹20 per executed order (2.5% cap, never binding in practice).
 * - STT: 0.1% on BOTH buy and sell.
 * - NSE transaction charge: 0.00297%.
 * - SEBI: 0.0001%.
 * - Stamp: 0.015% on buy.
 * - GST: 18%.
 * DP charge on sell (~₹18.5 + GST per scrip) is not modelled.
 */
export const EQUITY_DELIVERY: CostModel = {
  name: 'EQUITY_DELIVERY',
  brokeragePerOrder: 20,
  brokeragePct: 2.5,
  sttBuyPct: 0.1,
  sttSellPct: 0.1,
  exchangePct: 0.00297,
  sebiPct: 0.0001,
  stampBuyPct: 0.015,
  gstPct: 18,
};

/**
 * NSE index/stock options, charged on PREMIUM turnover.
 * - Brokerage: ₹20 flat per executed order.
 * - STT: 0.15% of premium on sell (raised from 0.1% by Union Budget 2026,
 *   effective 1 Apr 2026 — verify against /v2/charges/brokerage). Exercise
 *   STT on ITM expiry (0.125% of intrinsic) is not modelled.
 * - NSE transaction charge: 0.03503% of premium.
 * - SEBI: 0.0001%.
 * - Stamp: 0.003% on buy.
 * - GST: 18%.
 */
export const FNO_OPTIONS: CostModel = {
  name: 'FNO_OPTIONS',
  brokeragePerOrder: 20,
  brokeragePct: 0,
  sttBuyPct: 0,
  sttSellPct: 0.15,
  exchangePct: 0.03503,
  sebiPct: 0.0001,
  stampBuyPct: 0.003,
  gstPct: 18,
};

/**
 * NSE futures.
 * - Brokerage: ₹20 or 0.05% per executed order, whichever is lower.
 * - STT: 0.05% on sell (raised from 0.02% by Union Budget 2026, effective
 *   1 Apr 2026 — verify against /v2/charges/brokerage).
 * - NSE transaction charge: 0.00173%.
 * - SEBI: 0.0001%.
 * - Stamp: 0.002% on buy.
 * - GST: 18%.
 */
export const FNO_FUTURES: CostModel = {
  name: 'FNO_FUTURES',
  brokeragePerOrder: 20,
  brokeragePct: 0.05,
  sttBuyPct: 0,
  sttSellPct: 0.05,
  exchangePct: 0.00173,
  sebiPct: 0.0001,
  stampBuyPct: 0.002,
  gstPct: 18,
};

/** No charges at all. For engine tests and for isolating gross edge — never for approval. */
export const ZERO_COSTS: CostModel = {
  name: 'ZERO_COSTS',
  brokeragePerOrder: 0,
  brokeragePct: 0,
  sttBuyPct: 0,
  sttSellPct: 0,
  exchangePct: 0,
  sebiPct: 0,
  stampBuyPct: 0,
  gstPct: 0,
};

export interface CostBreakdown {
  readonly brokerage: number;
  readonly stt: number;
  readonly exchange: number;
  readonly sebi: number;
  readonly stamp: number;
  readonly gst: number;
  readonly total: number;
}

const pct = (amount: number, p: number): number => (amount * p) / 100;

function orderBrokerage(m: CostModel, turnover: number): number {
  if (m.brokeragePct > 0) return Math.min(m.brokeragePerOrder, pct(turnover, m.brokeragePct));
  return m.brokeragePerOrder;
}

/**
 * Itemised round-trip charges in rupees.
 *
 * `side` is the ENTRY side: a 'SELL' entry is a short, so its exit is the buy
 * leg (stamp duty and buy-side STT apply to the exit price).
 */
export function costBreakdown(
  m: CostModel, side: 'BUY' | 'SELL', qty: number, entry: number, exit: number,
): CostBreakdown {
  const buyPrice = side === 'BUY' ? entry : exit;
  const sellPrice = side === 'BUY' ? exit : entry;
  const buyTurnover = buyPrice * qty;
  const sellTurnover = sellPrice * qty;
  const turnover = buyTurnover + sellTurnover;

  const brokerage = orderBrokerage(m, buyTurnover) + orderBrokerage(m, sellTurnover);
  const stt = pct(buyTurnover, m.sttBuyPct) + pct(sellTurnover, m.sttSellPct);
  const exchange = pct(turnover, m.exchangePct);
  const sebi = pct(turnover, m.sebiPct);
  const stamp = pct(buyTurnover, m.stampBuyPct);
  const gst = pct(brokerage + exchange + sebi, m.gstPct);
  const total = brokerage + stt + exchange + sebi + stamp + gst;
  return { brokerage, stt, exchange, sebi, stamp, gst, total };
}

/** Total round-trip charges in rupees, rounded to the paisa. */
export function roundTripCost(
  m: CostModel, side: 'BUY' | 'SELL', qty: number, entry: number, exit: number,
): number {
  return Math.round(costBreakdown(m, side, qty, entry, exit).total * 100) / 100;
}

/**
 * Scale every charge by `k` (GST scales automatically because its base does).
 * Used by the cost-stress check: an edge that vanishes when costs double was
 * never an edge, it was a rounding error in the cost assumptions.
 */
export function scaleCosts(m: CostModel, k: number): CostModel {
  return {
    name: `${m.name}x${k}`,
    brokeragePerOrder: m.brokeragePerOrder * k,
    brokeragePct: m.brokeragePct * k,
    sttBuyPct: m.sttBuyPct * k,
    sttSellPct: m.sttSellPct * k,
    exchangePct: m.exchangePct * k,
    sebiPct: m.sebiPct * k,
    stampBuyPct: m.stampBuyPct * k,
    gstPct: m.gstPct,
  };
}
