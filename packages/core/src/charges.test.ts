import { describe, it, expect } from 'vitest';
import { computeIndianCharges } from './charges.ts';

describe('computeIndianCharges', () => {
  it('computes accurate intraday charges for an Indian equity trade', () => {
    // Buy 100 shares @ 1000, sell @ 1020
    const res = computeIndianCharges({
      style: 'INTRADAY',
      buyPrice: 1000,
      sellPrice: 1020,
      qty: 100,
    });

    expect(res.buyValue).toBe(100000);
    expect(res.sellValue).toBe(102000);
    expect(res.turnover).toBe(202000);
    expect(res.grossPnl).toBe(2000);

    // Brokerage: ₹20 buy + ₹20 sell = ₹40
    expect(res.brokerage).toBe(40);

    // STT: 0.025% on sell value (102000 * 0.00025 = 25.50)
    expect(res.stt).toBe(25.5);

    // NSE Exchange Txn: 0.00307% on turnover (202000 * 0.0000307 = 6.20)
    expect(res.exchangeTxn).toBeCloseTo(6.2, 1);

    // Stamp duty: 0.003% on buy value (100000 * 0.00003 = 3)
    expect(res.stampDuty).toBe(3);

    // GST: 18% on (brokerage + exchangeTxn + sebiFee) ~ 18% of 46.40 ~ 8.35
    expect(res.gst).toBeGreaterThan(8);

    // Net PnL must be gross PnL minus total charges
    expect(res.netPnl).toBe(res.grossPnl - res.totalCharges);
    expect(res.netPnl).toBeGreaterThan(1900); // After ~₹83 total charges

    // Breakeven price must be strictly greater than buy price
    expect(res.breakevenSellPrice).toBeGreaterThan(res.buyPrice);
    expect(res.pointsToBreakeven).toBeGreaterThan(0);
  });

  it('computes swing / delivery charges with both side STT and higher stamp duty', () => {
    const res = computeIndianCharges({
      style: 'SWING',
      buyPrice: 1000,
      sellPrice: 1100,
      qty: 100,
    });

    // STT is 0.1% on buy (100) + 0.1% on sell (110) = 210
    expect(res.stt).toBe(210);

    // Stamp duty is 0.015% on buy (15)
    expect(res.stampDuty).toBe(15);

    expect(res.netPnl).toBeLessThan(res.grossPnl);
    expect(res.breakevenSellPrice).toBeGreaterThan(res.buyPrice);
  });
});
