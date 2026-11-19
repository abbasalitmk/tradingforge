'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Catalog, type SetupView, type Side, Panel, Chip, Pill, Stat, Note, api, num, rupees, pct,
  sideColor, qualityColor, inputStyle, buttonStyle,
} from './ui.tsx';

/** A realtime request with no answer after this long is given up on and retried. */
const STALL_MS = 15_000;

interface Vote {
  strategyId: string;
  name: string;
  style: 'INTRADAY' | 'SWING';
  timeframe: '5m' | '1d' | null;
  side: Side | null;
  confidence: number;
  reasons: string[];
  entry: number | null;
  stopLoss: number | null;
  target: number | null;
}

interface StockView {
  symbol: string;
  name: string;
  asOf: number;
  marketOpen: boolean;
  entryWindowOpen: boolean;
  quote: { ltp: number | null; change: number | null; changePct: number | null; open: number | null; high: number | null; low: number | null; prevClose: number | null; volume: number | null };
  bars: { today: number; warmup: number; daily: number; forming: boolean };
  warnings: string[];
  indicators: {
    intraday: { rsi14: number | null; atr14: number | null; vwap: number | null; supertrend: string; rvol: number | null };
    daily: { rsi14: number | null; ema20: number | null; ema50: number | null; ema200: number | null; adx14: number | null; atr14: number | null; high52w: number | null; low52w: number | null; trend: string };
  };
  votes: Vote[];
  best: { INTRADAY: SetupView | null; SWING: SetupView | null };
  chart: Array<[number, number, number, number, number, number]>;
}

interface Edge {
  strategyId: string;
  trades: number | null;
  winRate: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  days: number;
}

interface AiView {
  setup: SetupView | null;
  reason: string | null;
  consensus: {
    verdict: string;
    confidence: number;
    consensusGrade?: string;
    rationale: string;
    riskFlags: string[];
    votes: Array<{ model: string; verdict: string; confidence: number; rationale: string }>;
  } | null;
}

interface SearchHit {
  symbol: string;
  name: string;
}

function SymbolSearch({ onPick }: { onPick: (symbol: string) => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 1) {
      setHits([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await api<{ results: SearchHit[] }>(`/api/market/search?q=${encodeURIComponent(term)}`);
      if (r.ok) setHits(r.data.results);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (s: string) => {
    onPick(s);
    setQ('');
    setHits([]);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', flex: '1 1 220px', maxWidth: 360 }}>
      <input
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) pick(hits[0].symbol);
          if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search any NSE stock (e.g. TATAMOTORS, Infosys)"
        aria-label="Search NSE stock"
        style={{ ...inputStyle, width: '100%' }}
      />
      {open && hits.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute', zIndex: 20, top: '100%', left: 0, right: 0, marginTop: 4, background: 'var(--panel)',
            border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--card-shadow-lg)',
          }}
        >
          {hits.map((h) => (
            <button
              key={h.symbol}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(h.symbol)}
              style={{
                display: 'flex', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', border: 'none',
                background: 'transparent', color: 'var(--fg)', cursor: 'pointer', fontSize: 12.5,
              }}
            >
              <strong style={{ fontFamily: 'monospace', minWidth: 96 }}>{h.symbol}</strong>
              <span style={{ color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Today's 5-minute closes as a line, with the session VWAP for reference. */
function Sparkline({ chart, vwap }: { chart: StockView['chart']; vwap: number | null }) {
  if (chart.length < 2) {
    return <Note>No bars from today yet{chart.length === 0 ? ' (market closed or before the first 5 minutes)' : ''}.</Note>;
  }
  const w = 640, h = 120, pad = 4;
  const closes = chart.map((c) => c[4]);
  const lo = Math.min(...chart.map((c) => c[3]), vwap ?? Infinity);
  const hi = Math.max(...chart.map((c) => c[2]), vwap ?? -Infinity);
  const x = (i: number) => pad + (i / (chart.length - 1)) * (w - 2 * pad);
  const y = (p: number) => pad + (1 - (p - lo) / (hi - lo || 1)) * (h - 2 * pad);
  const up = closes.at(-1)! >= closes[0]!;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block' }} role="img" aria-label="Today's price">
      {vwap !== null && <line x1={0} x2={w} y1={y(vwap)} y2={y(vwap)} stroke="var(--warn)" strokeDasharray="4 4" strokeWidth={1} opacity={0.7} />}
      <polyline fill="none" stroke={up ? 'var(--ok)' : 'var(--danger)'} strokeWidth={1.8} points={closes.map((c, i) => `${x(i)},${y(c)}`).join(' ')} />
    </svg>
  );
}

function SetupCard({ label, setup, names }: { label: string; setup: SetupView | null; names: Map<string, string> }) {
  if (!setup) {
    return (
      <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 650 }}>{label}</div>
        <Note>No strategy has a {label.toLowerCase()} setup right now.</Note>
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${sideColor(setup.side)}`, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 12, fontWeight: 650 }}>{label}</span>
        <Pill color={sideColor(setup.side)}>{setup.side}</Pill>
        <Pill color={qualityColor(setup.quality)}>Quality {setup.quality}</Pill>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>R:R {num(setup.rewardRisk)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
        <Stat label="Entry" value={rupees(setup.entry)} />
        <Stat label="Stop" value={rupees(setup.stopLoss)} color="var(--danger)" />
        <Stat label="Target" value={rupees(setup.target)} color="var(--ok)" />
      </div>
      <div style={{ fontSize: 11.5 }}>
        Led by <strong>{names.get(setup.primaryStrategyId) ?? setup.primaryStrategyId}</strong>
        {setup.agreeing.length > 0 && <span style={{ color: 'var(--ok)' }}> · {setup.agreeing.length} agree</span>}
        {setup.conflicting.length > 0 && <span style={{ color: 'var(--danger)' }}> · {setup.conflicting.length} disagree</span>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', lineHeight: 1.45 }}>
        {setup.reasons.slice(0, 5).map((r, i) => <div key={i}>• {r}</div>)}
      </div>
    </div>
  );
}

export default function StockAnalysis({ symbol, onSymbolChange, catalog }: {
  symbol: string;
  onSymbolChange: (symbol: string) => void;
  catalog: Catalog | null;
}) {
  const [view, setView] = useState<StockView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [edges, setEdges] = useState<{ symbol: string; rows: Edge[] } | null>(null);
  const [edgeError, setEdgeError] = useState<string | null>(null);
  const [ai, setAi] = useState<AiView | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const names = useMemo(() => new Map((catalog?.strategies ?? []).map((s) => [s.id, s.name])), [catalog]);
  const strategyParam = selected.length ? `&strategies=${selected.join(',')}` : '';

  // Realtime: every 5 s while the market is open, every minute otherwise.
  useEffect(() => {
    let alive = true;
    // Per effect, not per component: a request still pending for the previous
    // stock must never hold up the one just picked.
    let busySince = 0;
    let latest = 0;
    setView((v) => (v && v.symbol === symbol ? v : null));
    setError(null);
    const load = async () => {
      // One request at a time, but a fetch that never answers (dropped
      // connection, laptop asleep) is abandoned after STALL_MS instead of
      // stopping the refresh for good.
      if (busySince && Date.now() - busySince < STALL_MS) return;
      const id = ++latest;
      busySince = Date.now();
      const r = await api<StockView>(`/api/market/stock?symbol=${encodeURIComponent(symbol)}${strategyParam}`);
      if (id !== latest) return;
      busySince = 0;
      if (!alive) return;
      if (r.ok) {
        setView(r.data);
        setError(null);
      } else {
        setError(r.error);
      }
    };
    void load();
    if (!live) return () => { alive = false; };
    const every = view?.marketOpen === false ? 60_000 : 5_000;
    const t = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // view.marketOpen only changes the cadence; re-arming on every new view would reset the timer.
  }, [symbol, strategyParam, live, view?.marketOpen]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Backtest record: once per stock (it is cached for 30 minutes on the server).
  const loadEdges = async (s: string) => {
    setEdgeError(null);
    const r = await api<{ edges: Edge[] }>(`/api/market/stock/edge?symbol=${encodeURIComponent(s)}`);
    if (r.ok) setEdges({ symbol: s, rows: r.data.edges });
    else setEdgeError(r.error);
  };
  useEffect(() => {
    setEdges(null);
    void loadEdges(symbol);
  }, [symbol]);

  // AI: on a new stock, and again whenever the leading setup changes side or strategy.
  const best = view ? [view.best.INTRADAY, view.best.SWING].filter((s): s is SetupView => s !== null).sort((a, b) => b.quality - a.quality)[0] ?? null : null;
  const aiKey = `${symbol}|${strategyParam}|${best ? `${best.style}|${best.side}|${best.primaryStrategyId}` : 'none'}`;
  const aiKeyRef = useRef(aiKey);
  aiKeyRef.current = aiKey;
  const askAi = async (attempt = 0) => {
    const key = aiKey;
    setAiLoading(true);
    const r = await api<AiView>(`/api/market/stock/ai?symbol=${encodeURIComponent(symbol)}${strategyParam}`);
    if (key !== aiKeyRef.current) return; // another stock or setup since; its own request owns the panel
    if (!r.ok && r.status === 0 && attempt < 3) {
      // No response at all means the connection dropped, not that the AI failed.
      // The verdict is only re-requested when the setup changes, so retry here.
      setAi({ setup: null, consensus: null, reason: 'Connection dropped; retrying…' });
      setTimeout(() => void askAi(attempt + 1), 4_000);
      return;
    }
    setAiLoading(false);
    setAi(r.ok ? r.data : { setup: null, consensus: null, reason: r.error });
  };
  useEffect(() => {
    if (!view || view.symbol !== symbol) return;
    void askAi();
  }, [aiKey, view?.symbol]);

  const edgeOf = new Map((edges?.symbol === symbol ? edges.rows : []).map((e) => [e.strategyId, e]));
  const q = view?.quote;
  const firing = view?.votes.filter((v) => v.side !== null).length ?? 0;

  return (
    <Panel
      title="Stock analysis · realtime"
      subtitle={`Every strategy on one stock, refreshed ${view?.marketOpen === false ? 'every minute (market closed)' : 'every 5 seconds'}. Read-only: nothing here places an order.`}
      right={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', flex: '1 1 320px', justifyContent: 'flex-end' }}>
          <SymbolSearch onPick={onSymbolChange} />
          <Chip on={live} onClick={() => setLive((x) => !x)} title="Pause or resume auto-refresh">{live ? '● Live' : '❚❚ Paused'}</Chip>
        </div>
      }
    >
      {catalog && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 2 }}>Strategies:</span>
          <Chip on={selected.length === 0} onClick={() => setSelected([])}>All {catalog.strategies.length}</Chip>
          {catalog.strategies.map((s) => (
            <Chip
              key={s.id}
              title={s.description}
              on={selected.includes(s.id)}
              onClick={() => setSelected((cur) => (cur.includes(s.id) ? cur.filter((x) => x !== s.id) : [...cur, s.id]))}
            >
              {s.name} · {s.timeframe}
            </Chip>
          ))}
        </div>
      )}

      {error && <Note kind="danger">{symbol}: {error}</Note>}
      {!view && !error && <Note>Loading {symbol}…</Note>}

      {view && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline' }}>
            <span style={{ fontSize: 20, fontWeight: 750, fontFamily: 'monospace' }}>{view.symbol}</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{view.name}</span>
            <span style={{ fontSize: 20, fontWeight: 700, fontFamily: 'monospace' }}>{rupees(q?.ltp)}</span>
            <span style={{ fontSize: 13, fontWeight: 650, color: (q?.changePct ?? 0) >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
              {num(q?.change)} ({pct(q?.changePct)})
            </span>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              updated {Math.max(0, Math.round((now - view.asOf) / 1000))}s ago
            </span>
            <Pill color={view.marketOpen ? 'var(--ok)' : 'var(--muted)'}>{view.marketOpen ? 'MARKET OPEN' : 'MARKET CLOSED'}</Pill>
            {view.bars.forming && <Pill color="var(--accent)">INCLUDES FORMING BAR</Pill>}
          </div>
          {view.warnings.map((w, i) => <Note key={i} kind="warn">⚠ {w}</Note>)}
          {!view.entryWindowOpen && (
            <Note>Intraday strategies only signal between 09:20 and 14:45 IST, so outside that window only swing (daily) strategies can fire.</Note>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <Sparkline chart={view.chart} vwap={view.indicators.intraday.vwap} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6 }}>
                <Stat label="Open" value={rupees(q?.open)} />
                <Stat label="High" value={rupees(q?.high)} />
                <Stat label="Low" value={rupees(q?.low)} />
                <Stat label="Prev close" value={rupees(q?.prevClose)} />
                <Stat label="Volume" value={num(q?.volume, 0)} />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>INTRADAY (5-MIN)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6 }}>
                <Stat label="RSI 14" value={num(view.indicators.intraday.rsi14, 1)} />
                <Stat label="VWAP" value={rupees(view.indicators.intraday.vwap)} color="var(--warn)" />
                <Stat label="ATR 14" value={num(view.indicators.intraday.atr14)} />
                <Stat label="Supertrend" value={view.indicators.intraday.supertrend} color={view.indicators.intraday.supertrend === 'BULLISH' ? 'var(--ok)' : 'var(--danger)'} />
                <Stat label="RVOL" value={`${num(view.indicators.intraday.rvol)}x`} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>DAILY</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6 }}>
                <Stat label="Trend" value={view.indicators.daily.trend} color={view.indicators.daily.trend === 'UPTREND' ? 'var(--ok)' : view.indicators.daily.trend === 'DOWNTREND' ? 'var(--danger)' : 'var(--warn)'} />
                <Stat label="RSI 14" value={num(view.indicators.daily.rsi14, 1)} />
                <Stat label="ADX 14" value={num(view.indicators.daily.adx14, 1)} />
                <Stat label="EMA 20" value={num(view.indicators.daily.ema20)} />
                <Stat label="EMA 50" value={num(view.indicators.daily.ema50)} />
                <Stat label="EMA 200" value={num(view.indicators.daily.ema200)} />
                <Stat label="52w high" value={num(view.indicators.daily.high52w)} />
                <Stat label="52w low" value={num(view.indicators.daily.low52w)} />
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
            <SetupCard label="Intraday" setup={view.best.INTRADAY} names={names} />
            <SetupCard label="Swing" setup={view.best.SWING} names={names} />
          </div>

          <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 12.5, fontWeight: 650 }}>AI verdict on the best setup</div>
              <button type="button" onClick={() => void askAi()} disabled={aiLoading} style={{ ...buttonStyle, padding: '5px 10px', fontSize: 11.5, opacity: aiLoading ? 0.6 : 1 }}>
                {aiLoading ? 'Asking…' : 'Ask again'}
              </button>
            </div>
            {!ai && <Note>{aiLoading ? 'Reviewing…' : 'Waiting for the analysis.'}</Note>}
            {ai && !ai.consensus && <Note>{ai.reason}</Note>}
            {ai?.consensus && (
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <Pill color={ai.consensus.verdict === 'CONFIRM' ? 'var(--ok)' : ai.consensus.verdict === 'REJECT' ? 'var(--danger)' : 'var(--warn)'}>
                    {ai.consensus.verdict}
                  </Pill>
                  {ai.consensus.consensusGrade && <Pill color="var(--accent)">Grade {ai.consensus.consensusGrade}</Pill>}
                  <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>confidence {ai.consensus.confidence}%</span>
                  {ai.setup && <span style={{ fontSize: 11.5 }}>on the {ai.setup.style.toLowerCase()} {ai.setup.side} setup</span>}
                </div>
                <Note>{ai.consensus.rationale}</Note>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 6 }}>
                  {ai.consensus.votes.map((v, i) => (
                    <div key={i} style={{ background: 'var(--panel-subtle)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: 11 }}>
                        <span style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.model}</span>
                        <span style={{ color: v.verdict === 'CONFIRM' ? 'var(--ok)' : v.verdict === 'REJECT' ? 'var(--danger)' : 'var(--warn)' }}>
                          {v.verdict} {v.confidence}%
                        </span>
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{v.rationale}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div style={{ fontSize: 12.5, fontWeight: 650 }}>Strategies · {firing} of {view.votes.length} signalling</div>
              <Note>
                Backtest columns: each strategy on {view.symbol} with default settings and costs (45 days of 5-min bars, ~1 year of daily).
                {edgeError && <> <span style={{ color: 'var(--danger)' }}>{edgeError}</span> <button type="button" onClick={() => loadEdges(symbol)} style={{ ...buttonStyle, padding: '2px 8px', fontSize: 11 }}>Retry</button></>}
              </Note>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 760 }}>
                <thead>
                  <tr style={{ color: 'var(--muted)', fontSize: 10.5, textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
                    <th style={{ padding: '6px 8px' }}>Strategy</th>
                    <th style={{ padding: '6px 8px' }}>Signal</th>
                    <th style={{ padding: '6px 8px' }}>Entry / Stop / Target</th>
                    <th style={{ padding: '6px 8px' }}>Why</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Trades</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Win %</th>
                    <th style={{ padding: '6px 8px', textAlign: 'right' }}>Avg R</th>
                  </tr>
                </thead>
                <tbody>
                  {view.votes.map((v) => {
                    const e = edgeOf.get(v.strategyId);
                    return (
                      <tr key={v.strategyId} style={{ borderBottom: '1px solid var(--line-subtle)', verticalAlign: 'top' }}>
                        <td style={{ padding: '7px 8px' }}>
                          <div style={{ fontWeight: 600 }}>{v.name}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{v.style.toLowerCase()} · {v.timeframe}</div>
                        </td>
                        <td style={{ padding: '7px 8px', whiteSpace: 'nowrap' }}>
                          {v.side ? <><strong style={{ color: sideColor(v.side) }}>{v.side}</strong> <span style={{ color: 'var(--muted)' }}>{v.confidence}%</span></> : <span style={{ color: 'var(--muted)' }}>—</span>}
                        </td>
                        <td style={{ padding: '7px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                          {v.entry !== null ? `${num(v.entry)} / ${num(v.stopLoss)} / ${num(v.target)}` : '—'}
                        </td>
                        <td style={{ padding: '7px 8px', fontSize: 11, color: 'var(--muted)', maxWidth: 340 }}>{v.reasons.slice(0, 2).join('; ') || '—'}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{e ? (e.trades ?? 'n/a') : '…'}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontFamily: 'monospace' }}>{e?.winRate != null ? `${Math.round(e.winRate * 100)}` : '—'}</td>
                        <td style={{ padding: '7px 8px', textAlign: 'right', fontFamily: 'monospace', color: e?.expectancyR == null ? 'var(--muted)' : e.expectancyR > 0 ? 'var(--ok)' : 'var(--danger)' }}>
                          {e?.expectancyR != null ? num(e.expectancyR) : '—'}
                          {e?.trades != null && e.trades > 0 && e.trades < 10 && <span title="Fewer than 10 trades: an anecdote, not an edge" style={{ color: 'var(--warn)' }}> *</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Note>* fewer than 10 trades: too few to call it an edge. Past results on one stock do not predict the next trade.</Note>
          </div>
        </>
      )}
    </Panel>
  );
}
