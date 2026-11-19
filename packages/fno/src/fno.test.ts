import { describe, it, expect } from 'vitest';
import { newSignalId, type Paise, type Signal } from '@tradeforger/core';
import { parseMaster, parseEquities, FnoUniverse, daysToExpiry, type DerivativeContract } from './contracts.ts';
import { analyzeChain, classifyBuildup, type OptionChain, type OptionQuote, type ChainRow } from './chain.ts';
import { pickExpiry, pickStrike, DEFAULT_STRIKE_PARAMS } from './select.ts';
import { planOption, planFuture, DEFAULT_OPTION_PLAN } from './plan.ts';

const P = (r: number) => Math.round(r * 100) as Paise;

// ───────────────────────────── fixtures ─────────────────────────────

const masterRows = [
  { segment: 'NSE_FO', instrument_key: 'NSE_FO|1', trading_symbol: 'NIFTY FUT 24 NOV 26', instrument_type: 'FUT',
    underlying_symbol: 'NIFTY', underlying_key: 'NSE_INDEX|Nifty 50', underlying_type: 'INDEX',
    expiry: Date.parse('2026-11-24T18:29:59Z'), strike_price: 0, lot_size: 65, tick_size: 10, freeze_quantity: 1755 },
  { segment: 'NSE_FO', instrument_key: 'NSE_FO|2', trading_symbol: 'NIFTY FUT 29 DEC 26', instrument_type: 'FUT',
    underlying_symbol: 'NIFTY', underlying_key: 'NSE_INDEX|Nifty 50', underlying_type: 'INDEX',
    expiry: Date.parse('2026-12-29T18:29:59Z'), strike_price: 0, lot_size: 65, tick_size: 10, freeze_quantity: 1755 },
  { segment: 'NSE_FO', instrument_key: 'NSE_FO|3', trading_symbol: 'NIFTY 25000 CE 24 NOV 26', instrument_type: 'CE',
    underlying_symbol: 'NIFTY', underlying_key: 'NSE_INDEX|Nifty 50', underlying_type: 'INDEX',
    expiry: Date.parse('2026-11-24T18:29:59Z'), strike_price: 25000, lot_size: 65, tick_size: 5, freeze_quantity: 1755 },
  { segment: 'NSE_EQ', instrument_key: 'NSE_EQ|X', trading_symbol: 'X', instrument_type: 'EQ', lot_size: 1, tick_size: 5 },
  { segment: 'NSE_FO', instrument_key: 'NSE_FO|bad', trading_symbol: 'no expiry', instrument_type: 'CE', lot_size: 65, tick_size: 5 },
];

/** A smooth synthetic chain: deltas fall with strike, puts mirror calls. */
function chain(over: { spot?: number; callOi?: (k: number) => number; putOi?: (k: number) => number;
  spreadPct?: number; iv?: number; theta?: number; priceChgPct?: number; oiChgPct?: number } = {}): OptionChain {
  const spot = over.spot ?? 25010;
  const rows: ChainRow[] = [];
  for (let k = 24600; k <= 25400; k += 50) {
    const m = (spot - k) / 200;
    const cDelta = 1 / (1 + Math.exp(-m));
    const leg = (delta: number, oi: number, intrinsic: number): OptionQuote => {
      const ltp = Math.max(5, intrinsic + 120 * Math.exp(-((spot - k) ** 2) / 200_000));
      const half = (ltp * (over.spreadPct ?? 1)) / 200;
      const chg = 1 + (over.priceChgPct ?? 0) / 100;
      return {
        instrumentKey: `NSE_FO|${k}${delta > 0 ? 'C' : 'P'}`, ltp, bid: ltp - half, ask: ltp + half,
        closePrice: ltp / chg, oi, prevOi: oi / (1 + (over.oiChgPct ?? 0) / 100), volume: 10_000,
        iv: over.iv ?? 14, delta, gamma: 0.0006, theta: over.theta ?? -6, vega: 10,
      };
    };
    rows.push({
      strike: k,
      call: leg(cDelta, over.callOi?.(k) ?? 1_000_000, Math.max(0, spot - k)),
      put: leg(cDelta - 1, over.putOi?.(k) ?? 1_000_000, Math.max(0, k - spot)),
    });
  }
  return { underlyingKey: 'NSE_INDEX|Nifty 50', expiry: '2026-11-24', spot, rows, fetchedAt: 1 };
}

const signal = (side: 'BUY' | 'SELL', entry = 25010, risk = 40, rr = 2): Signal => ({
  id: newSignalId(), instrumentKey: 'NSE_FO|1', symbol: 'NIFTY', style: 'INTRADAY', side,
  entry: P(entry),
  stopLoss: P(side === 'BUY' ? entry - risk : entry + risk),
  target: P(side === 'BUY' ? entry + risk * rr : entry - risk * rr),
  atr: risk / 1.5, confidence: 75, reasons: ['ORB'], indicators: {}, generatedAt: 0,
});

const resolver = (c: OptionChain) => (strike: number, type: 'CE' | 'PE'): DerivativeContract => ({
  instrumentKey: `NSE_FO|${strike}${type[0]}`, tradingSymbol: `NIFTY ${strike} ${type} 24 NOV 26`,
  underlyingSymbol: 'NIFTY', underlyingKey: c.underlyingKey, underlyingType: 'INDEX', instrumentType: type,
  strike, expiry: c.expiry, expiryMs: 0, lotSize: 65, tickSize: 0.05, freezeQuantity: 1755, weekly: true,
});

// ───────────────────────────── contracts ─────────────────────────────

describe('instrument master', () => {
  const contracts = parseMaster(masterRows);

  it('keeps only well-formed NSE_FO rows', () => {
    expect(contracts.map((c) => c.instrumentKey)).toEqual(['NSE_FO|1', 'NSE_FO|2', 'NSE_FO|3']);
  });

  it('converts the master tick size from paise to rupees', () => {
    expect(contracts.find((c) => c.instrumentType === 'CE')!.tickSize).toBe(0.05);
    expect(contracts.find((c) => c.instrumentType === 'FUT')!.tickSize).toBe(0.1);
  });

  it('expresses expiry as the IST calendar date', () => {
    expect(contracts[0]!.expiry).toBe('2026-11-24');
  });

  it('rolls the signal future off the expiring contract', () => {
    const u = new FnoUniverse(contracts);
    expect(u.nearFuture('NIFTY', '2026-11-18')!.instrumentKey).toBe('NSE_FO|1');
    expect(u.nearFuture('NIFTY', '2026-11-23')!.instrumentKey).toBe('NSE_FO|2');
    expect(u.underlyingKey('NIFTY')).toBe('NSE_INDEX|Nifty 50');
  });

  it('extracts only EQ-series equities for the scan universe', () => {
    const eq = parseEquities([
      ...masterRows,
      { segment: 'NSE_EQ', instrument_key: 'NSE_EQ|INE002A01018', trading_symbol: 'RELIANCE', instrument_type: 'EQ', short_name: 'Reliance Industries', isin: 'INE002A01018' },
      { segment: 'NSE_EQ', instrument_key: 'NSE_EQ|SME1', trading_symbol: 'SMEX', instrument_type: 'SM' },
    ]);
    expect(eq.map((e) => e.symbol)).toEqual(['X', 'RELIANCE']);
    expect(eq[1]!.name).toBe('Reliance Industries');
  });

  it('counts days to expiry in calendar days', () => {
    expect(daysToExpiry('2026-11-24', '2026-11-18')).toBe(6);
    expect(daysToExpiry('2026-11-24', '2026-11-24')).toBe(0);
  });
});

describe('expiry selection', () => {
  it('skips expiry-day contracts by default', () => {
    expect(pickExpiry(['2026-11-18', '2026-11-25'], '2026-11-18')).toBe('2026-11-25');
  });
  it('returns null when nothing qualifies', () => {
    expect(pickExpiry(['2026-11-18'], '2026-11-18', 1)).toBeNull();
  });
});

// ───────────────────────────── analytics ─────────────────────────────

describe('chain analytics', () => {
  it('finds the ATM strike, PCR and walls', () => {
    const a = analyzeChain(chain({
      callOi: (k) => (k === 25200 ? 9_000_000 : 1_000_000),
      putOi: (k) => (k === 24800 ? 8_000_000 : 1_000_000),
    }));
    expect(a.atmStrike).toBe(25000);
    expect(a.callWall).toBe(25200);
    expect(a.putWall).toBe(24800);
    expect(a.straddle).toBeGreaterThan(0);
    expect(a.expectedMovePct).toBeCloseTo((a.straddle! / 25010) * 100, 1);
  });

  it('puts max pain at the strike that pays writers least', () => {
    // All OI stacked at 25100 on both sides: writers pay nothing if it expires there.
    const big = (k: number) => (k === 25100 ? 5_000_000 : 0);
    expect(analyzeChain(chain({ callOi: big, putOi: big })).maxPain).toBe(25100);
  });

  it('reads heavy put writing as bullish and heavy call writing as bearish', () => {
    expect(analyzeChain(chain({ putOi: () => 2_000_000 })).biasScore).toBeGreaterThan(0);
    expect(analyzeChain(chain({ callOi: () => 2_000_000 })).biasScore).toBeLessThan(0);
  });

  it('classifies the price/OI quadrant', () => {
    expect(classifyBuildup(3, 5)).toBe('LONG_BUILDUP');
    expect(classifyBuildup(-3, 5)).toBe('SHORT_BUILDUP');
    expect(classifyBuildup(3, -5)).toBe('SHORT_COVERING');
    expect(classifyBuildup(-3, -5)).toBe('LONG_UNWINDING');
    expect(classifyBuildup(0.1, 5)).toBe('NEUTRAL');
  });

  it('explains every point of the bias score', () => {
    const a = analyzeChain(chain({ putOi: () => 2_000_000 }));
    const fromNotes = a.notes.reduce((s, n) => s + Number(n.split(' ')[0]), 0);
    expect(fromNotes).toBe(a.biasScore);
  });
});

// ───────────────────────────── selection ─────────────────────────────

describe('strike selection', () => {
  it('picks the CE nearest the target delta', () => {
    const r = pickStrike(chain(), 'CE');
    expect(r.ok).toBe(true);
    if (r.ok) expect(Math.abs(r.pick.delta! - 0.5)).toBeLessThan(0.1);
  });

  it('picks a put for a bearish view with |delta| near target', () => {
    const r = pickStrike(chain(), 'PE');
    expect(r.ok && r.pick.quote.delta! < 0).toBe(true);
  });

  it('rejects an illiquid chain and says why', () => {
    const r = pickStrike(chain({ spreadPct: 10 }), 'CE');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons.join()).toContain('spread');
  });

  it('respects the premium band', () => {
    const r = pickStrike(chain(), 'CE', { ...DEFAULT_STRIKE_PARAMS, maxPremium: 1 });
    expect(r.ok).toBe(false);
  });
});

// ───────────────────────────── planning ─────────────────────────────

describe('option trade plan', () => {
  const c = chain();
  const a = analyzeChain(c);

  it('buys a CE for a bullish signal and a PE for a bearish one — never writes', () => {
    const bull = planOption(signal('BUY'), c, a, resolver(c));
    const bear = planOption(signal('SELL'), c, a, resolver(c));
    expect(bull.ok && bull.plan.contract.instrumentType).toBe('CE');
    expect(bear.ok && bear.plan.contract.instrumentType).toBe('PE');
    expect(bull.ok && bull.plan.side).toBe('BUY');
    expect(bear.ok && bear.plan.side).toBe('BUY');
  });

  it('places stop below and target above the premium, on the tick grid', () => {
    const r = planOption(signal('BUY'), c, a, resolver(c));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { entry, stopLoss, target } = r.plan;
    expect(stopLoss).toBeLessThan(entry);
    expect(target).toBeGreaterThan(entry);
    for (const px of [entry, stopLoss, target]) expect(px % 5).toBe(0); // ₹0.05 = 5 paise
  });

  it('never risks more than the premium-loss ceiling', () => {
    // A huge underlying stop would imply losing most of the premium.
    const r = planOption(signal('BUY', 25010, 400, 2), c, a, resolver(c));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lossPct = ((r.plan.entry - r.plan.stopLoss) / r.plan.entry) * 100;
    expect(lossPct).toBeLessThanOrEqual(DEFAULT_OPTION_PLAN.maxPremiumLossPct + 0.5);
    expect(r.plan.flags).toContain('STOP_CLAMPED_TO_MAX_LOSS');
  });

  it('rejects when the premium reward:risk is too thin', () => {
    const r = planOption(signal('BUY', 25010, 40, 0.5), c, a, resolver(c));
    expect(r.ok).toBe(false);
  });

  it('refuses to buy expensive volatility', () => {
    const hot = chain({ iv: 90 });
    expect(planOption(signal('BUY'), hot, analyzeChain(hot), resolver(hot)).ok).toBe(false);
  });

  it('refuses when theta decay outruns the setup', () => {
    const decaying = chain({ theta: -60 });
    expect(planOption(signal('BUY'), decaying, analyzeChain(decaying), resolver(decaying)).ok).toBe(false);
  });

  it('vetoes a trade when the chain is strongly positioned against it', () => {
    const bearish = { ...a, biasScore: -70, bias: 'BEARISH' as const };
    const r = planOption(signal('BUY'), c, bearish, resolver(c));
    expect(r.ok).toBe(false);
  });

  it('flags a call wall sitting between spot and the target', () => {
    const r = planOption(signal('BUY'), c, { ...a, callWall: 25050 }, resolver(c));
    expect(r.ok && r.plan.flags.some((f) => f.startsWith('CALL_WALL'))).toBe(true);
  });

  it('sets the trailing gap at the initial premium risk', () => {
    const r = planOption(signal('BUY'), c, a, resolver(c));
    if (r.ok) expect(r.plan.trailingGap).toBe(r.plan.entry - r.plan.stopLoss);
  });
});

describe('futures plan', () => {
  const fut = parseMaster(masterRows)[0]!;

  it('keeps the signal side and shifts levels across the basis', () => {
    const r = planFuture(signal('SELL', 2500, 10), fut, 2515, 2500);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.side).toBe('SELL');
    expect(r.plan.entry).toBe(P(2515));
    expect(r.plan.stopLoss - r.plan.entry).toBe(P(10));
    expect(r.plan.flags).toContain('UNCAPPED_GAP_RISK');
  });
});
