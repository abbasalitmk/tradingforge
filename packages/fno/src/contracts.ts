import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { istDateKey } from '@tradeforger/core';

/** Public, unauthenticated, refreshed daily by Upstox. ~2 MB gzipped. */
export const NSE_MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';

export type DerivativeType = 'CE' | 'PE' | 'FUT';

export interface DerivativeContract {
  readonly instrumentKey: string;      // "NSE_FO|50978"
  readonly tradingSymbol: string;      // "NIFTY 27000 CE 29 DEC 26"
  readonly underlyingSymbol: string;   // "NIFTY"
  readonly underlyingKey: string;      // "NSE_INDEX|Nifty 50"
  readonly underlyingType: 'INDEX' | 'EQUITY';
  readonly instrumentType: DerivativeType;
  readonly strike: number | null;
  /** IST calendar date, YYYY-MM-DD — the form the option-chain API takes. */
  readonly expiry: string;
  readonly expiryMs: number;
  readonly lotSize: number;
  /** In RUPEES. The master publishes tick size in paise (5.0 = ₹0.05). */
  readonly tickSize: number;
  /** Largest quantity the exchange accepts in one order. */
  readonly freezeQuantity: number;
  readonly weekly: boolean;
}

const masterRow = z.object({
  segment: z.string(),
  instrument_key: z.string(),
  trading_symbol: z.string(),
  instrument_type: z.string(),
  underlying_symbol: z.string().optional(),
  underlying_key: z.string().optional(),
  underlying_type: z.string().optional(),
  expiry: z.number().optional(),
  strike_price: z.number().optional(),
  lot_size: z.number(),
  tick_size: z.number(),
  freeze_quantity: z.number().optional(),
  weekly: z.boolean().optional(),
}).passthrough();

/**
 * Keep only well-formed NSE derivatives. A row missing an expiry, lot size or
 * underlying cannot be traded safely, so it is dropped rather than defaulted.
 */
export function parseMaster(rows: readonly unknown[]): DerivativeContract[] {
  const out: DerivativeContract[] = [];
  for (const raw of rows) {
    const r = masterRow.safeParse(raw);
    if (!r.success) continue;
    const m = r.data;
    if (m.segment !== 'NSE_FO') continue;
    const type = m.instrument_type;
    if (type !== 'CE' && type !== 'PE' && type !== 'FUT') continue;
    if (!m.expiry || !m.underlying_symbol || !m.underlying_key || m.lot_size < 1) continue;
    out.push({
      instrumentKey: m.instrument_key,
      tradingSymbol: m.trading_symbol,
      underlyingSymbol: m.underlying_symbol,
      underlyingKey: m.underlying_key,
      underlyingType: m.underlying_type === 'INDEX' ? 'INDEX' : 'EQUITY',
      instrumentType: type,
      strike: type === 'FUT' ? null : (m.strike_price ?? null),
      expiry: istDateKey(new Date(m.expiry)),
      expiryMs: m.expiry,
      lotSize: m.lot_size,
      tickSize: m.tick_size / 100,
      freezeQuantity: m.freeze_quantity ?? Number.MAX_SAFE_INTEGER,
      weekly: m.weekly ?? false,
    });
  }
  return out;
}

export interface EquityInstrument {
  readonly instrumentKey: string;   // "NSE_EQ|INE002A01018"
  readonly symbol: string;          // "RELIANCE"
  readonly name: string;
  readonly isin: string | null;
}

/**
 * Plain NSE equities from the same master — the full-market scan universe.
 * Only `EQ` series: BE/BZ/SM trade-for-trade and SME series have settlement
 * and liquidity rules the intraday engine is not built for.
 */
export function parseEquities(rows: readonly unknown[]): EquityInstrument[] {
  const out: EquityInstrument[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (r['segment'] !== 'NSE_EQ' || r['instrument_type'] !== 'EQ') continue;
    const key = r['instrument_key'];
    const symbol = r['trading_symbol'];
    if (typeof key !== 'string' || typeof symbol !== 'string') continue;
    out.push({
      instrumentKey: key,
      symbol,
      name: typeof r['short_name'] === 'string' ? r['short_name'] : typeof r['name'] === 'string' ? r['name'] : symbol,
      isin: typeof r['isin'] === 'string' ? r['isin'] : null,
    });
  }
  return out;
}

/** The raw master rows — one download serves derivatives and equities. */
export async function fetchMasterRows(
  url: string = NSE_MASTER_URL,
  fetchFn: typeof fetch = fetch,
): Promise<unknown[]> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`instrument master: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rows: unknown = JSON.parse(gunzipSync(buf).toString('utf8'));
  if (!Array.isArray(rows)) throw new Error('instrument master: expected a JSON array');
  return rows;
}

export async function fetchMaster(
  url: string = NSE_MASTER_URL,
  fetchFn: typeof fetch = fetch,
): Promise<DerivativeContract[]> {
  const contracts = parseMaster(await fetchMasterRows(url, fetchFn));
  if (contracts.length === 0) throw new Error('instrument master: no NSE_FO contracts parsed');
  return contracts;
}

/** Calendar days from an IST date to an expiry date; 0 on expiry day. */
export function daysToExpiry(expiry: string, today: string): number {
  return Math.round((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
}

/** Lookup over one day's derivative contracts. */
export class FnoUniverse {
  private readonly bySymbol = new Map<string, DerivativeContract[]>();
  private readonly byKey = new Map<string, DerivativeContract>();

  constructor(contracts: readonly DerivativeContract[]) {
    for (const c of contracts) {
      this.byKey.set(c.instrumentKey, c);
      const list = this.bySymbol.get(c.underlyingSymbol) ?? [];
      list.push(c);
      this.bySymbol.set(c.underlyingSymbol, list);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  has(symbol: string): boolean {
    return this.bySymbol.has(symbol);
  }

  contract(instrumentKey: string): DerivativeContract | null {
    return this.byKey.get(instrumentKey) ?? null;
  }

  underlyingKey(symbol: string): string | null {
    return this.bySymbol.get(symbol)?.[0]?.underlyingKey ?? null;
  }

  /** Expiries still tradeable on `today`, nearest first. */
  expiries(symbol: string, kind: 'OPTION' | 'FUT', today: string): string[] {
    const set = new Set<string>();
    for (const c of this.bySymbol.get(symbol) ?? []) {
      if ((kind === 'FUT') !== (c.instrumentType === 'FUT')) continue;
      if (c.expiry >= today) set.add(c.expiry);
    }
    return [...set].sort();
  }

  /**
   * The future to read signals from. Rolls to the next month once the near
   * contract is within `rollDays` of expiry: volume migrates and the expiring
   * contract's candles stop being representative.
   */
  nearFuture(symbol: string, today: string, rollDays = 1): DerivativeContract | null {
    const futs = (this.bySymbol.get(symbol) ?? [])
      .filter((c) => c.instrumentType === 'FUT' && c.expiry >= today)
      .sort((a, b) => a.expiryMs - b.expiryMs);
    return futs.find((c) => daysToExpiry(c.expiry, today) > rollDays) ?? futs[0] ?? null;
  }

  option(symbol: string, expiry: string, strike: number, type: 'CE' | 'PE'): DerivativeContract | null {
    return (this.bySymbol.get(symbol) ?? []).find(
      (c) => c.instrumentType === type && c.expiry === expiry && c.strike === strike,
    ) ?? null;
  }
}
