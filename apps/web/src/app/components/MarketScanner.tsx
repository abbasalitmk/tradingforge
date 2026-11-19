'use client';

import React, { useMemo, useState } from 'react';
import {
  type Catalog, type SetupView, Panel, Chip, Pill, Note, api, num, rupees, pct,
  sideColor, qualityColor, inputStyle, buttonStyle,
} from './ui.tsx';

interface ScanRow {
  symbol: string;
  name: string;
  industry: string | null;
  ltp: number;
  changePct: number;
  turnoverCr: number;
  atrPct: number;
  rvol: number | null;
  setup: SetupView;
}

interface ScanResponse {
  categoryName: string;
  listSource: string;
  universe: number;
  quoted: number;
  shortlisted: number;
  results: ScanRow[];
  entryWindowOpen: boolean;
  warnings: string[];
  durationMs: number;
  asOf: number;
}

/** Number inputs are kept as text so an empty box means "no filter". */
interface FilterText {
  minPrice: string;
  maxPrice: string;
  minChangePct: string;
  maxChangePct: string;
  minTurnoverCr: string;
  minRvol: string;
  minQuality: string;
  minRewardRisk: string;
}

const EMPTY: FilterText = {
  minPrice: '', maxPrice: '', minChangePct: '', maxChangePct: '', minTurnoverCr: '', minRvol: '', minQuality: '', minRewardRisk: '',
};

const PRESETS: Array<{ label: string; category?: string; f: Partial<FilterText> }> = [
  { label: 'Under ₹100', category: 'ALL', f: { maxPrice: '100', minTurnoverCr: '5' } },
  { label: '₹100–500', category: 'ALL', f: { minPrice: '100', maxPrice: '500', minTurnoverCr: '10' } },
  { label: '₹500–2,000', category: 'ALL', f: { minPrice: '500', maxPrice: '2000', minTurnoverCr: '20' } },
  { label: 'Gainers > 2%', f: { minChangePct: '2' } },
  { label: 'Losers < −2%', f: { maxChangePct: '-2' } },
  { label: 'Volume spike', f: { minRvol: '2' } },
  { label: 'High quality', f: { minQuality: '70', minRewardRisk: '1.5' } },
];

const FIELDS: Array<{ key: keyof FilterText; label: string; placeholder: string }> = [
  { key: 'minPrice', label: 'Min price ₹', placeholder: 'any' },
  { key: 'maxPrice', label: 'Max price ₹', placeholder: 'any' },
  { key: 'minChangePct', label: 'Min change %', placeholder: 'any' },
  { key: 'maxChangePct', label: 'Max change %', placeholder: 'any' },
  { key: 'minTurnoverCr', label: 'Min turnover ₹Cr', placeholder: 'any' },
  { key: 'minRvol', label: 'Min RVOL', placeholder: 'any' },
  { key: 'minQuality', label: 'Min quality', placeholder: '0–100' },
  { key: 'minRewardRisk', label: 'Min R:R', placeholder: 'any' },
];

export default function MarketScanner({ catalog, onAnalyze }: { catalog: Catalog | null; onAnalyze: (symbol: string) => void }) {
  const [category, setCategory] = useState('NIFTY50');
  const [f, setF] = useState<FilterText>(EMPTY);
  const [style, setStyle] = useState<'ANY' | 'INTRADAY' | 'SWING'>('ANY');
  const [side, setSide] = useState<'ANY' | 'BUY' | 'SELL'>('ANY');
  const [limit, setLimit] = useState(25);
  const [strategies, setStrategies] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResponse | null>(null);

  const names = useMemo(() => new Map((catalog?.strategies ?? []).map((s) => [s.id, s.name])), [catalog]);
  const groups = useMemo(() => {
    const g = new Map<string, Catalog['categories']>();
    for (const c of catalog?.categories ?? []) g.set(c.group, [...(g.get(c.group) ?? []), c]);
    return [...g];
  }, [catalog]);

  const run = async () => {
    setRunning(true);
    setError(null);
    const filters: Record<string, unknown> = { style, side, limit };
    for (const { key } of FIELDS) {
      const v = f[key].trim();
      if (v !== '' && Number.isFinite(Number(v))) filters[key] = Number(v);
    }
    if (strategies.length) filters['strategies'] = strategies;
    const r = await api<ScanResponse>('/api/market/scan', { category, filters });
    setRunning(false);
    if (r.ok) setResult(r.data);
    else setError(r.error);
  };

  const isAll = category === 'ALL';

  return (
    <Panel
      title="Market scanner"
      subtitle="Scan an index, a sector or the whole NSE by price and activity, then rank every stock's setups across all strategies."
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" style={{ ...inputStyle, minWidth: 200 }}>
          {groups.length === 0 && <option value="NIFTY50">NIFTY 50</option>}
          {groups.map(([group, cats]) => (
            <optgroup key={group} label={group}>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </optgroup>
          ))}
        </select>
        <select value={style} onChange={(e) => setStyle(e.target.value as typeof style)} aria-label="Style" style={inputStyle}>
          <option value="ANY">Intraday + swing</option>
          <option value="INTRADAY">Intraday only</option>
          <option value="SWING">Swing only</option>
        </select>
        <select value={side} onChange={(e) => setSide(e.target.value as typeof side)} aria-label="Side" style={inputStyle}>
          <option value="ANY">Buy + sell</option>
          <option value="BUY">Buy only</option>
          <option value="SELL">Sell only</option>
        </select>
        <label style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
          Top
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={inputStyle}>
            {[10, 25, 50].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button type="button" onClick={run} disabled={running} style={{ ...buttonStyle, opacity: running ? 0.6 : 1, cursor: running ? 'wait' : 'pointer' }}>
          {running ? 'Scanning…' : 'Run scan'}
        </button>
        <button type="button" onClick={() => { setF(EMPTY); setStrategies([]); setStyle('ANY'); setSide('ANY'); }} style={{ ...buttonStyle, background: 'transparent', border: '1px solid var(--line)', color: 'var(--muted)' }}>
          Reset
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>Presets:</span>
        {PRESETS.map((p) => (
          <Chip key={p.label} on={false} onClick={() => { setF({ ...EMPTY, ...p.f }); if (p.category) setCategory(p.category); }}>
            {p.label}
          </Chip>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(118px, 1fr))', gap: 8 }}>
        {FIELDS.map(({ key, label, placeholder }) => (
          <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 10.5, color: 'var(--muted)' }}>
            {label}
            <input
              inputMode="decimal"
              value={f[key]}
              placeholder={placeholder}
              onChange={(e) => setF((cur) => ({ ...cur, [key]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
              style={inputStyle}
            />
          </label>
        ))}
      </div>

      {catalog && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Strategies:</span>
          <Chip on={strategies.length === 0} onClick={() => setStrategies([])}>All {catalog.strategies.length}</Chip>
          {catalog.strategies.map((s) => (
            <Chip
              key={s.id}
              title={s.description}
              on={strategies.includes(s.id)}
              onClick={() => setStrategies((cur) => (cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]))}
            >
              {s.name}
            </Chip>
          ))}
        </div>
      )}

      {isAll && !f.minPrice && !f.maxPrice && !f.minTurnoverCr && (
        <Note>All NSE has ~2,800 stocks; only the 40 most liquid and active after your filters are analysed. A price band or turnover floor focuses it.</Note>
      )}
      {error && <Note kind="danger">Scan failed: {error}</Note>}

      {result && (
        <>
          <Note>
            {result.categoryName} · list {result.listSource} · {result.universe} stocks, {result.quoted} quoted,
            {' '}{result.shortlisted} analysed with {strategies.length || catalog?.strategies.length || 'all'} strategies
            {' '}in {(result.durationMs / 1000).toFixed(1)}s · {result.results.length} setups
          </Note>
          {!result.entryWindowOpen && (
            <Note kind="warn">Outside 09:20–14:45 IST intraday strategies do not signal, so these are swing (daily) setups only.</Note>
          )}
          {result.warnings.map((w, i) => <Note key={i} kind="warn">⚠ {w}</Note>)}
          <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--line)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 900 }}>
              <thead>
                <tr style={{ background: 'var(--panel-subtle)', color: 'var(--muted)', fontSize: 10.5, textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '8px 10px' }}>#</th>
                  <th style={{ padding: '8px 10px' }}>Stock</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>LTP</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Change</th>
                  <th style={{ padding: '8px 10px' }}>Setup</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>Quality</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>R:R</th>
                  <th style={{ padding: '8px 10px' }}>Entry / Stop / Target</th>
                  <th style={{ padding: '8px 10px' }}>Lead strategy</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right' }}>RVOL</th>
                  <th style={{ padding: '8px 10px' }} />
                </tr>
              </thead>
              <tbody>
                {result.results.map((r, i) => (
                  <tr
                    key={`${r.symbol}-${r.setup.style}`}
                    style={{
                      borderBottom: '1px solid var(--line-subtle)',
                      background: i % 2 === 1 ? 'var(--panel-subtle)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '9px 10px', color: 'var(--muted)' }}>{i + 1}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <div style={{ fontWeight: 700, fontFamily: 'monospace', color: 'var(--fg)' }}>{r.symbol}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.industry ?? r.name}
                      </div>
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>{rupees(r.ltp)}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: r.changePct >= 0 ? 'var(--ok)' : 'var(--danger)' }}>{pct(r.changePct)}</td>
                    <td style={{ padding: '9px 10px', whiteSpace: 'nowrap' }}>
                      <Pill color={sideColor(r.setup.side)}>{r.setup.side}</Pill>{' '}
                      <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>{r.setup.style.toLowerCase()}</span>
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 700, color: qualityColor(r.setup.quality) }}>{r.setup.quality}</td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{num(r.setup.rewardRisk)}</td>
                    <td style={{ padding: '9px 10px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {num(r.setup.entry)} / <span style={{ color: 'var(--danger)' }}>{num(r.setup.stopLoss)}</span> / <span style={{ color: 'var(--ok)' }}>{num(r.setup.target)}</span>
                    </td>
                    <td style={{ padding: '9px 10px', fontSize: 11.5 }}>
                      <div style={{ fontWeight: 600 }}>{names.get(r.setup.primaryStrategyId) ?? r.setup.primaryStrategyId}</div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                        {r.setup.agreeing.length} agree · {r.setup.conflicting.length} disagree
                      </div>
                    </td>
                    <td style={{ padding: '9px 10px', textAlign: 'right', fontFamily: 'monospace' }}>{r.rvol === null ? '—' : `${num(r.rvol)}x`}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <button type="button" onClick={() => onAnalyze(r.symbol)} style={{ ...buttonStyle, padding: '4px 10px', fontSize: 11 }}>
                        Analyse
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.results.length === 0 && <Note>No setups matched. Loosen the filters or try another category.</Note>}
        </>
      )}
    </Panel>
  );
}
