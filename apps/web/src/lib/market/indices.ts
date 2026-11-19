import { MEMBERS, STOCKS, SNAPSHOT_DATE } from './indices-snapshot.ts';

export interface IndexCategory {
  readonly id: string;
  readonly name: string;
  readonly group: 'Broad' | 'Market cap' | 'Sector';
  /** File name under NSE's index-constituent archive. */
  readonly file: string;
}

export const INDEX_CATEGORIES: readonly IndexCategory[] = [
  { id: 'NIFTY50', name: 'NIFTY 50', group: 'Broad', file: 'ind_nifty50list.csv' },
  { id: 'NIFTYNEXT50', name: 'NIFTY Next 50', group: 'Broad', file: 'ind_niftynext50list.csv' },
  { id: 'NIFTY100', name: 'NIFTY 100', group: 'Broad', file: 'ind_nifty100list.csv' },
  { id: 'NIFTY200', name: 'NIFTY 200', group: 'Broad', file: 'ind_nifty200list.csv' },
  { id: 'NIFTY500', name: 'NIFTY 500', group: 'Broad', file: 'ind_nifty500list.csv' },
  { id: 'NIFTYMIDCAP50', name: 'NIFTY Midcap 50', group: 'Market cap', file: 'ind_niftymidcap50list.csv' },
  { id: 'NIFTYMIDCAP100', name: 'NIFTY Midcap 100', group: 'Market cap', file: 'ind_niftymidcap100list.csv' },
  { id: 'NIFTYMIDCAP150', name: 'NIFTY Midcap 150', group: 'Market cap', file: 'ind_niftymidcap150list.csv' },
  { id: 'NIFTYSMALLCAP100', name: 'NIFTY Smallcap 100', group: 'Market cap', file: 'ind_niftysmallcap100list.csv' },
  { id: 'NIFTYSMALLCAP250', name: 'NIFTY Smallcap 250', group: 'Market cap', file: 'ind_niftysmallcap250list.csv' },
  { id: 'NIFTYBANK', name: 'NIFTY Bank', group: 'Sector', file: 'ind_niftybanklist.csv' },
  { id: 'NIFTYFINANCE', name: 'NIFTY Financial Services', group: 'Sector', file: 'ind_niftyfinancelist.csv' },
  { id: 'NIFTYPSUBANK', name: 'NIFTY PSU Bank', group: 'Sector', file: 'ind_niftypsubanklist.csv' },
  { id: 'NIFTYIT', name: 'NIFTY IT', group: 'Sector', file: 'ind_niftyitlist.csv' },
  { id: 'NIFTYAUTO', name: 'NIFTY Auto', group: 'Sector', file: 'ind_niftyautolist.csv' },
  { id: 'NIFTYPHARMA', name: 'NIFTY Pharma', group: 'Sector', file: 'ind_niftypharmalist.csv' },
  { id: 'NIFTYHEALTHCARE', name: 'NIFTY Healthcare', group: 'Sector', file: 'ind_niftyhealthcarelist.csv' },
  { id: 'NIFTYFMCG', name: 'NIFTY FMCG', group: 'Sector', file: 'ind_niftyfmcglist.csv' },
  { id: 'NIFTYMETAL', name: 'NIFTY Metal', group: 'Sector', file: 'ind_niftymetallist.csv' },
  { id: 'NIFTYREALTY', name: 'NIFTY Realty', group: 'Sector', file: 'ind_niftyrealtylist.csv' },
  { id: 'NIFTYENERGY', name: 'NIFTY Energy', group: 'Sector', file: 'ind_niftyenergylist.csv' },
  { id: 'NIFTYOILGAS', name: 'NIFTY Oil & Gas', group: 'Sector', file: 'ind_niftyoilgaslist.csv' },
  { id: 'NIFTYMEDIA', name: 'NIFTY Media', group: 'Sector', file: 'ind_niftymedialist.csv' },
  { id: 'NIFTYCONSUMERDURABLES', name: 'NIFTY Consumer Durables', group: 'Sector', file: 'ind_niftyconsumerdurableslist.csv' },
];

export interface Constituent {
  readonly symbol: string;
  readonly name: string;
  readonly industry: string;
  readonly isin: string;
  /** Upstox keys equities by ISIN. */
  readonly instrumentKey: string;
}

export const NSE_INDEX_ARCHIVE = 'https://archives.nseindia.com/content/indices/';

/** One CSV line, honouring double-quoted fields. */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** NSE's "Company Name,Industry,Symbol,Series,ISIN Code" file. EQ series only. */
export function parseConstituents(csv: string): Constituent[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const head = csvFields(lines[0] ?? '').map((h) => h.toLowerCase());
  const col = (name: string) => head.findIndex((h) => h.startsWith(name));
  const [iName, iInd, iSym, iSer, iIsin] = [col('company'), col('industry'), col('symbol'), col('series'), col('isin')];
  if (iSym < 0 || iIsin < 0) throw new Error('unexpected index file header');
  const out: Constituent[] = [];
  for (const line of lines.slice(1)) {
    const f = csvFields(line);
    const symbol = f[iSym], isin = f[iIsin];
    if (!symbol || !isin || (iSer >= 0 && f[iSer] !== 'EQ')) continue;
    out.push({ symbol, name: f[iName] ?? symbol, industry: f[iInd] ?? '', isin, instrumentKey: `NSE_EQ|${isin}` });
  }
  return out;
}

/** From the snapshot committed with the code; used when NSE cannot be reached. */
export function snapshotConstituents(id: string): Constituent[] {
  return (MEMBERS[id] ?? []).flatMap((symbol) => {
    const s = STOCKS[symbol];
    return s ? [{ symbol, name: s[0], industry: s[1], isin: s[2], instrumentKey: `NSE_EQ|${s[2]}` }] : [];
  });
}

export interface IndexList {
  readonly category: IndexCategory;
  readonly constituents: readonly Constituent[];
  /** 'live' from NSE today, or the snapshot date. */
  readonly source: 'live' | `snapshot ${string}`;
}

/**
 * Current constituents from NSE, falling back to the snapshot. NSE rebalances
 * twice a year and can refuse cloud IPs, so the snapshot keeps scanning
 * working either way and the response says which list was used.
 */
export async function loadIndex(id: string, fetchFn: typeof fetch = fetch): Promise<IndexList> {
  const category = INDEX_CATEGORIES.find((c) => c.id === id);
  if (!category) throw new Error(`unknown index ${id}`);
  try {
    const res = await fetchFn(NSE_INDEX_ARCHIVE + category.file, {
      headers: { 'user-agent': 'Mozilla/5.0 (TradeForger dashboard)' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const constituents = parseConstituents(await res.text());
    if (constituents.length === 0) throw new Error('empty list');
    return { category, constituents, source: 'live' };
  } catch {
    return { category, constituents: snapshotConstituents(id), source: `snapshot ${SNAPSHOT_DATE}` };
  }
}
