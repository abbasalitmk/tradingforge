/**
 * Indian Equity & F&O Statutory Charges & Taxes Calculator.
 *
 * Implements statutory and exchange charges for Indian stock exchanges (NSE/BSE)
 * as per SEBI regulations, Stamp Duty Act, and Finance Act 2024/2026.
 *
 * Rates:
 *  - Brokerage (Upstox intraday): 0.06% of order value, capped at ₹20 per order
 *    (Upstox's brokerage API, 27 Nov 2026: ₹6.00 on a ₹10,000 order, ₹20 on ₹50,000).
 *  - STT (Securities Transaction Tax):
 *      Intraday: 0.025% on sell side only (0 on buy)
 *      Delivery/Swing: 0.1% on buy & 0.1% on sell
 *  - NSE Exchange Transaction Fee: 0.00307% of turnover
 *  - SEBI Turnover Fee: ₹10 per crore (0.000001 of turnover)
 *  - Stamp Duty:
 *      Intraday: 0.003% (0.00003) on buy side
 *      Delivery/Swing: 0.015% (0.00015) on buy side
 *  - GST: 18% on (Brokerage + Exchange Txn + SEBI Fee)
 */

export interface TradeChargesBreakdown {
  readonly segment: 'INTRADAY' | 'SWING';
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly qty: number;
  readonly buyValue: number;
  readonly sellValue: number;
  readonly turnover: number;
  readonly grossPnl: number;
  readonly brokerage: number;
  readonly stt: number;
  readonly exchangeTxn: number;
  readonly sebiFee: number;
  readonly stampDuty: number;
  readonly gst: number;
  readonly totalCharges: number;
  readonly netPnl: number;
  readonly breakevenSellPrice: number;
  readonly pointsToBreakeven: number;
  readonly chargesPctOfTurnover: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeIndianCharges(params: {
  readonly style: 'INTRADAY' | 'SWING';
  readonly buyPrice: number;
  readonly sellPrice: number;
  readonly qty: number;
  readonly flatBrokerage?: number;
}): TradeChargesBreakdown {
  const { style, buyPrice, sellPrice, qty } = params;
  const isIntraday = style === 'INTRADAY';

  const buyValue = round2(buyPrice * qty);
  const sellValue = round2(sellPrice * qty);
  const turnover = round2(buyValue + sellValue);
  const grossPnl = round2((sellPrice - buyPrice) * qty);

  // Brokerage: 0.06% per executed leg, capped at ₹20 (the cap binds above ₹33,333)
  const legBrokerage = (val: number) => {
    if (val <= 0) return 0;
    if (params.flatBrokerage !== undefined) return params.flatBrokerage;
    return Math.min(20, round2(val * 0.0006));
  };
  const brokerage = round2(legBrokerage(buyValue) + legBrokerage(sellValue));

  // STT: 0.025% on sell for intraday; 0.1% on buy+sell for delivery/swing
  const stt = isIntraday
    ? round2(sellValue * 0.00025)
    : round2(buyValue * 0.001 + sellValue * 0.001);

  // Exchange txn fee: NSE 0.00307% of turnover
  const exchangeTxn = round2(turnover * 0.0000307);

  // SEBI turnover fee: ₹10 per crore (0.000001)
  const sebiFee = round2(turnover * 0.000001);

  // Stamp duty: 0.003% on buy for intraday, 0.015% on buy for delivery
  const stampDuty = isIntraday
    ? round2(buyValue * 0.00003)
    : round2(buyValue * 0.00015);

  // GST: 18% on (brokerage + exchangeTxn + sebiFee)
  const gst = round2(0.18 * (brokerage + exchangeTxn + sebiFee));

  const totalCharges = round2(brokerage + stt + exchangeTxn + sebiFee + stampDuty + gst);
  const netPnl = round2(grossPnl - totalCharges);

  // Approximate Breakeven price calculation
  // At breakeven: (P_sell - P_buy)*qty = Total_Charges(P_sell)
  // Total_Charges has fixed/quasi-fixed components (brokerage ~40, stamp duty) + variable per sell (STT + NSE + GST)
  // Variable sell rate:
  const sellTaxRate = (isIntraday ? 0.00025 : 0.001) + 0.0000307 * 1.18 + 0.000001 * 1.18;
  const buySideFixedCosts = legBrokerage(buyValue) * 1.18 + buyValue * 0.0000307 * 1.18 + stampDuty + (isIntraday ? 0 : buyValue * 0.001);
  const estSellBrokerageAndGst = 20 * 1.18;
  const baseCharges = buySideFixedCosts + estSellBrokerageAndGst;

  const breakevenSellPrice = qty > 0
    ? round2((buyValue + baseCharges) / (qty * (1 - sellTaxRate)))
    : buyPrice;

  const pointsToBreakeven = round2(Math.max(0, breakevenSellPrice - buyPrice));
  const chargesPctOfTurnover = turnover > 0 ? round2((totalCharges / turnover) * 100) : 0;

  return {
    segment: style,
    buyPrice,
    sellPrice,
    qty,
    buyValue,
    sellValue,
    turnover,
    grossPnl,
    brokerage,
    stt,
    exchangeTxn,
    sebiFee,
    stampDuty,
    gst,
    totalCharges,
    netPnl,
    breakevenSellPrice,
    pointsToBreakeven,
    chargesPctOfTurnover,
  };
}
