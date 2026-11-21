'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import StockAnalysis from './components/StockAnalysis.tsx';
import MarketScanner from './components/MarketScanner.tsx';
import AutoPilot from './components/AutoPilot.tsx';
import OrphanResolver from './components/OrphanResolver.tsx';
import TradeBlotter from './components/TradeBlotter.tsx';
import Hint from './components/Hint.tsx';
import BeginnerCard from './components/BeginnerCard.tsx';
import LiveStatusBar from './components/LiveStatusBar.tsx';
import TradingModeToggle, { type TradingMode } from './components/TradingModeToggle.tsx';
import type { Catalog } from './components/ui.tsx';

interface WatchlistItem {
  instrumentKey: string;
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  lastUpdated: number;
  bars?: number;
}

interface TradeSetup {
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target1: number;
  target2: number;
  trailingGap: number;
  riskPerShare: number;
  rewardToRisk1: number;
  rewardToRisk2: number;
  recommendedShares?: (budget: number) => number;
}

interface ScoredStockItem {
  instrumentKey: string;
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  volume: number;
  orbStatus: 'ABOVE' | 'BELOW' | 'INSIDE';
  supertrendDir: 'BULLISH' | 'BEARISH';
  rsi: number;
  vwap: number;
  rvol: number;
  atr: number;
  score: number;
  rank: number;
  reasons: string[];
  tradeSetup: TradeSetup;
}

interface PositionItem {
  id: string;
  instrumentKey: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  state: string;
  quantity: number;
  filledQuantity: number;
  entry: number;
  avgEntry: number | null;
  stopLoss: number;
  target: number;
  ltp: number;
  pnlRupees: number;
  gttOrderId: string | null;
  openedAt: number;
  segment?: 'EQ' | 'FO';
  product?: string;
  contract?: {
    tradingSymbol: string;
    instrumentType: 'CE' | 'PE' | 'FUT';
    strike: number | null;
    expiry: string;
    lotSize: number;
    lots: number;
  };
  underlyingSymbol?: string;
  exitReason?: string | null;
  /** Order path the position lives on; its exits always go back there. */
  broker?: 'PAPER' | 'UPSTOX';
  style?: 'INTRADAY' | 'SWING';
  strategyId?: string | null;
  quality?: number | null;
  capitalRupees?: number;
  filledAt?: number | null;
  closedAt?: number | null;
  exitPrice?: number | null;
}

type Buildup = 'LONG_BUILDUP' | 'SHORT_BUILDUP' | 'SHORT_COVERING' | 'LONG_UNWINDING' | 'NEUTRAL';

interface FnoAnalytics {
  spot: number;
  atmStrike: number;
  pcrOi: number;
  pcrVolume: number;
  maxPain: number;
  callWall: number;
  putWall: number;
  atmIv: number | null;
  ivSkew: number | null;
  straddle: number | null;
  expectedMovePct: number | null;
  callBuildup: Buildup;
  putBuildup: Buildup;
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  biasScore: number;
  notes: string[];
  updatedAt: number;
}

interface FnoUnderlying {
  symbol: string;
  underlyingKey: string;
  signalKey: string;
  spot: number | null;
  expiry: string | null;
  lotSize: number | null;
  error: string | null;
  analytics: FnoAnalytics | null;
}

interface FnoPlanView {
  id: string;
  symbol: string;
  contract: {
    instrumentKey: string;
    tradingSymbol: string;
    instrumentType: 'CE' | 'PE' | 'FUT';
    strike: number | null;
    expiry: string;
    lotSize: number;
  };
  side: 'BUY' | 'SELL';
  lots: number;
  quantity: number;
  premium: { entry: number; stopLoss: number; target: number; trailingGap: number | null };
  underlying: { side: 'BUY' | 'SELL'; entry: number; stopLoss: number; target: number };
  delta: number | null;
  iv: number | null;
  spreadPct: number | null;
  costRupees: number;
  maxLossRupees: number;
  rewardRupees: number;
  confidence: number;
  reasons: string[];
  flags: string[];
  status: 'ANALYSIS' | 'PLANNED' | 'PLACED' | 'REJECTED';
  rejectReason: string | null;
  createdAt: number;
}

interface FnoState {
  enabled: boolean;
  instrument: 'OPTIONS' | 'FUTURES';
  underlyings: FnoUnderlying[];
  plans: FnoPlanView[];
}

interface FnoAnalyzeResult {
  loading: boolean;
  error: string | null;
  analytics: FnoAnalytics | null;
  plan: FnoPlanView | null;
  rejected: string[];
}

interface MarketSession {
  kind: 'today' | 'previous';
  date: string;
}

/** GET /api/market/overview: computed by the dashboard itself, no engine involved. */
interface MarketOverview {
  asOf: number;
  session: MarketSession | null;
  watchlist: WatchlistItem[];
  rankedStocks: ScoredStockItem[];
  topStock: ScoredStockItem | null;
}

interface MarketFno {
  asOf: number;
  instrument: 'OPTIONS' | 'FUTURES';
  underlyings: FnoUnderlying[];
}

type ApiResult<T = Record<string, unknown>> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; offline: boolean };

/**
 * POST to the engine proxy and return the engine's real outcome. Never assumes
 * success: any non-2xx (including 503 engine_offline) becomes an error carrying
 * the engine's own `error` text.
 */
async function postEngine<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/proxy${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, offline: true, error: `Dashboard server unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  if (res.ok) return { ok: true, status: res.status, data: obj as T };
  const isOffline = obj['offline'] === true || obj['error'] === 'engine_offline';
  const errText =
    typeof obj['error'] === 'string'
      ? (obj['error'] as string)
      : typeof obj['message'] === 'string'
        ? (obj['message'] as string)
        : `HTTP ${res.status}`;
  return {
    ok: false,
    status: res.status,
    offline: isOffline,
    error: isOffline ? 'Engine offline — action NOT executed' : `${errText} (HTTP ${res.status})`,
  };
}

/** POST to a market route. These never touch the engine, so there is no engine-offline case. */
async function postMarket<T = Record<string, unknown>>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok && data) return { ok: true, status: res.status, data: data as T };
    const msg = typeof data?.['message'] === 'string' ? data['message'] : typeof data?.['error'] === 'string' ? data['error'] : 'Request failed';
    return { ok: false, status: res.status, offline: false, error: `${msg} (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, status: 0, offline: true, error: `Dashboard server unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const fmt = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d);
const inr = (n: number | null | undefined, d = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const agoSec = (ts: number, now: number): string => `${Math.max(0, Math.round((now - ts) / 1000))}s ago`;

const ARM_PHRASE = 'I UNDERSTAND THIS USES REAL MONEY';

const BUILDUP_COLOR: Record<Buildup, string> = {
  LONG_BUILDUP: 'var(--ok)',
  SHORT_COVERING: 'var(--ok)',
  SHORT_BUILDUP: 'var(--danger)',
  LONG_UNWINDING: 'var(--danger)',
  NEUTRAL: 'var(--muted)',
};

const PLAN_STATUS_STYLE: Record<FnoPlanView['status'], { bg: string; fg: string }> = {
  ANALYSIS: { bg: 'var(--panel-subtle)', fg: 'var(--muted)' },
  PLANNED: { bg: 'var(--accent-subtle)', fg: 'var(--accent-fg)' },
  PLACED: { bg: 'var(--ok-subtle)', fg: 'var(--ok-fg)' },
  REJECTED: { bg: 'var(--danger-subtle)', fg: 'var(--danger-fg)' },
};

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'var(--panel-subtle)', border: '1px solid var(--line)', padding: '6px 8px', borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 1, fontFamily: 'monospace', color: color ?? 'var(--fg)' }}>{value}</div>
    </div>
  );
}

function FnoPlanDetail({ plan }: { plan: FnoPlanView }) {
  const isLong = plan.side === 'BUY';
  return (
    <div style={{ background: 'var(--panel-subtle)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>{plan.contract.tradingSymbol}</span>
        <span
          style={{
            padding: '1px 6px',
            borderRadius: 4,
            fontSize: 10,
            fontWeight: 700,
            background: isLong ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)',
            color: isLong ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          {plan.side} {plan.lots} lot{plan.lots === 1 ? '' : 's'} ({plan.quantity} qty)
        </span>
        <span style={{ padding: '1px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700, background: PLAN_STATUS_STYLE[plan.status].bg, color: PLAN_STATUS_STYLE[plan.status].fg }}>
          {plan.status}
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>conf {plan.confidence}%</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6 }}>
        <Metric label="ENTRY (prem)" value={inr(plan.premium.entry)} />
        <Metric label="STOP LOSS" value={inr(plan.premium.stopLoss)} color="var(--danger)" />
        <Metric label="TARGET" value={inr(plan.premium.target)} color="var(--ok)" />
        <Metric label="TRAIL GAP" value={inr(plan.premium.trailingGap)} />
        <Metric label="COST" value={inr(plan.costRupees, 0)} />
        <Metric label="MAX LOSS" value={inr(plan.maxLossRupees, 0)} color="var(--danger)" />
        <Metric label="REWARD" value={inr(plan.rewardRupees, 0)} color="var(--ok)" />
        <Metric label="DELTA" value={fmt(plan.delta)} />
        <Metric label="IV" value={plan.iv === null ? '—' : `${fmt(plan.iv, 1)}%`} />
        <Metric label="SPREAD" value={plan.spreadPct === null ? '—' : `${fmt(plan.spreadPct, 2)}%`} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
        Underlying {plan.underlying.side} @ {fmt(plan.underlying.entry)} · SL {fmt(plan.underlying.stopLoss)} · T {fmt(plan.underlying.target)}
      </div>
      {plan.reasons.length > 0 && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
          {plan.reasons.map((r, i) => (
            <div key={i}>• {r}</div>
          ))}
        </div>
      )}
      {plan.flags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {plan.flags.map((f, i) => (
            <span key={i} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--warn)', color: 'var(--warn)' }}>
              {f}
            </span>
          ))}
        </div>
      )}
      {plan.rejectReason && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>Rejected: {plan.rejectReason}</div>}
    </div>
  );
}

interface MultiModelVote {
  model: string;
  verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
  confidence: number;
  rationale: string;
  flags?: string[];
}

interface SignalItem {
  id: string;
  instrumentKey: string;
  symbol: string;
  style: 'INTRADAY' | 'SWING';
  side: 'BUY' | 'SELL';
  entry: number;
  stopLoss: number;
  target: number;
  confidence: number;
  reasons: string[];
  ai: {
    verdict: 'CONFIRM' | 'CAUTION' | 'REJECT';
    confidence: number;
    consensusGrade?: 'A+' | 'A' | 'B' | 'REJECT';
    agreeCount?: number;
    totalModels?: number;
    riskFlags: string[];
    rationale: string;
    sizeMultiplier: number;
    blocked: boolean;
    model: string;
    votes?: MultiModelVote[];
  };
  generatedAt: number;
}

interface EngineState {
  mode: 'PAPER' | 'SANDBOX' | 'LIVE_ARMED' | 'LIVE';
  baseMode: string;
  isArmed: boolean;
  autoTrading: boolean;
  autoTargetMode?: 'ALL_SCANNED' | 'SINGLE_STOCK';
  autoTargetSymbol?: string;
  autoMinPrice?: number;
  autoMaxPrice?: number;
  strategyMode: 'INTRADAY' | 'SWING' | 'BOTH';
  sizing: {
    mode: 'FIXED_BUDGET' | 'FIXED_QTY' | 'RISK_BASED';
    budget: number;
    fixedQty: number;
    riskPct: number;
  };
  limits: {
    maxSpendPerTrade: number;
    maxDeployed: number;
    dailyLossLimitPct: number;
  };
  pnl: {
    realised: number;
    unrealised: number;
    total: number;
  };
  breakers: {
    allowEntries: boolean;
    allowExits: boolean;
    trips: Array<{ id: string; detail: string; allowExits: boolean }>;
  };
  telemetry: {
    istTime: string;
    uptimeMs: number;
    ticks: number;
    feedStaleness: number | null;
    subscribedCount: number;
    priceSource?: 'WEBSOCKET' | 'REST_POLL' | 'NONE';
    feedIssue?: string | null;
    ordersCount: number;
    signalsCount: number;
  };
  auth?: {
    hasTradingToken: boolean;
    hasAnalyticsToken: boolean;
    tradingExpiresInMs: number | null;
    loginUrl: string;
  };
  watchlist: WatchlistItem[];
  rankedStocks?: ScoredStockItem[];
  topStock?: ScoredStockItem | null;
  positions: PositionItem[];
  recentSignals: SignalItem[];
  fno?: FnoState;
}

export default function Dashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('INFY');
  const [deepAnalysisStock, setDeepAnalysisStock] = useState<ScoredStockItem | null>(null);
  const [deepAnalysisVotes, setDeepAnalysisVotes] = useState<MultiModelVote[] | null>(null);
  const [deepAnalysisLoading, setDeepAnalysisLoading] = useState<boolean>(false);
  const [deepAnalysisError, setDeepAnalysisError] = useState<string | null>(null);
  const [killModalOpen, setKillModalOpen] = useState(false);
  const [killPending, setKillPending] = useState<'SOFT' | 'HARD' | 'NUCLEAR' | null>(null);
  const [killError, setKillError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  // Engine connectivity: null = never reached yet. `offlineReason` set => data on screen is NOT live.
  const [offlineReason, setOfflineReason] = useState<string | null>(null);
  const [lastLiveAt, setLastLiveAt] = useState<number | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [fnoResults, setFnoResults] = useState<Record<string, FnoAnalyzeResult>>({});
  const [fnoTogglePending, setFnoTogglePending] = useState(false);
  const [armOpen, setArmOpen] = useState(false);
  const [armPhrase, setArmPhrase] = useState('');
  const [resolving, setResolving] = useState<PositionItem | null>(null);
  /** Position id → last announced phase, so each fill and exit is announced exactly once. */
  const announced = useRef<Map<string, 'OPEN' | 'CLOSED'> | null>(null);
  const [armPending, setArmPending] = useState(false);
  const [armError, setArmError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketOverview | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketFno, setMarketFno] = useState<MarketFno | null>(null);
  const [marketFnoError, setMarketFnoError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [focusSymbol, setFocusSymbol] = useState('RELIANCE');
  const analysisRef = useRef<HTMLDivElement | null>(null);
  const [customSizingInput, setCustomSizingInput] = useState<string>('');
  const [autoTargetMode, setAutoTargetMode] = useState<'ALL_SCANNED' | 'SINGLE_STOCK'>('ALL_SCANNED');
  const [autoTargetSymbol, setAutoTargetSymbol] = useState<string>('RELIANCE');
  const [manualStockInput, setManualStockInput] = useState<string>('');

  // Unified Filter & Sizing Form State
  const [formTargetMode, setFormTargetMode] = useState<'ALL_SCANNED' | 'SINGLE_STOCK'>('ALL_SCANNED');
  const [formTargetSymbol, setFormTargetSymbol] = useState<string>('RELIANCE');
  const [formMinPrice, setFormMinPrice] = useState<string>('');
  const [formMaxPrice, setFormMaxPrice] = useState<string>('');
  const [formStrategyMode, setFormStrategyMode] = useState<'INTRADAY' | 'SWING' | 'BOTH'>('BOTH');
  const [formSizingMode, setFormSizingMode] = useState<'FIXED_BUDGET' | 'FIXED_QTY' | 'RISK_BASED'>('FIXED_BUDGET');
  const [formBudget, setFormBudget] = useState<string>('10000');
  const [formFixedQty, setFormFixedQty] = useState<string>('10');
  const [formRiskPct, setFormRiskPct] = useState<string>('1.0');
  const [applyingFilters, setApplyingFilters] = useState<boolean>(false);

  // Search Autocomplete State for NSE Symbols
  const [symbolSearchQuery, setSymbolSearchQuery] = useState('');
  const [symbolSearchResults, setSymbolSearchResults] = useState<Array<{ symbol: string; name: string }>>([]);
  const [isSearchingSymbols, setIsSearchingSymbols] = useState(false);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const hasInitForm = useRef(false);

  // Debounced search for NSE symbols
  useEffect(() => {
    const q = symbolSearchQuery.trim();
    if (!q) {
      setSymbolSearchResults([]);
      setIsSearchingSymbols(false);
      setShowSearchDropdown(false);
      return;
    }
    setIsSearchingSymbols(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/market/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
        if (res.ok) {
          const body = await res.json();
          if (body?.results && Array.isArray(body.results)) {
            setSymbolSearchResults(body.results.slice(0, 10));
            setShowSearchDropdown(true);
          }
        }
      } catch {
        // silent
      } finally {
        setIsSearchingSymbols(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [symbolSearchQuery]);

  useEffect(() => {
    const handleSync = (e: Event) => {
      const custom = e as CustomEvent<{ mode: 'PAPER' | 'LIVE' }>;
      if (custom.detail?.mode) {
        const target = custom.detail.mode;
        setState((prev) => (prev ? { ...prev, mode: target, isArmed: target === 'LIVE' } : null));
      }
    };
    window.addEventListener('tf:mode-change', handleSync);
    return () => window.removeEventListener('tf:mode-change', handleSync);
  }, []);

  type TabId = 'overview' | 'autopilot' | 'scanner' | 'breakouts' | 'analysis' | 'positions' | 'fno';
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  // Deep links: /#autopilot opens that tab, and the address follows the tab, so a
  // phone bookmark or a shared link lands where it was meant to.
  useEffect(() => {
    const TABS: readonly TabId[] = ['overview', 'autopilot', 'scanner', 'breakouts', 'analysis', 'positions', 'fno'];
    const fromHash = () => {
      const h = window.location.hash.slice(1) as TabId;
      if (TABS.includes(h)) setActiveTab(h);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  useEffect(() => {
    const want = activeTab === 'overview' ? '' : `#${activeTab}`;
    if (window.location.hash !== want) window.history.replaceState(null, '', want || window.location.pathname);
  }, [activeTab]);
  const [manualRefreshing, setManualRefreshing] = useState(false);

  const handleSelectAndAnalyze = (symbol: string) => {
    setFocusSymbol(symbol);
    setSelectedSymbol(symbol);
    setActiveTab('analysis');
    analysisRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const showToast = (text: string, kind: 'ok' | 'error' = 'ok') => {
    setToast({ text, kind });
    setTimeout(() => setToast((cur) => (cur && cur.text === text ? null : cur)), kind === 'error' ? 8000 : 3000);
  };

  // Announce every fill and every exit once, as the engine reports it. The first
  // poll only records what already exists, so a page load does not replay history.
  useEffect(() => {
    if (!state) return;
    const first = announced.current === null;
    const seen = announced.current ?? new Map<string, 'OPEN' | 'CLOSED'>();
    for (const p of state.positions) {
      const phase = p.state === 'CLOSED' ? 'CLOSED' : p.filledQuantity > 0 ? 'OPEN' : null;
      if (!phase || seen.get(p.id) === phase) continue;
      seen.set(p.id, phase);
      if (first) continue;
      const sym = p.contract?.tradingSymbol ?? p.symbol;
      const where = p.broker === 'UPSTOX' ? 'LIVE' : 'paper';
      if (phase === 'OPEN') {
        showToast(`🟢 ${p.side === 'BUY' ? 'Bought' : 'Sold short'} ${p.filledQuantity} × ${sym} @ ₹${(p.avgEntry ?? p.entry).toFixed(2)} (${where})${p.strategyId ? ` · ${p.strategyId}` : ''}${p.quality != null ? ` Q${p.quality}` : ''}`);
      } else {
        showToast(
          `${p.pnlRupees >= 0 ? '✅' : '🔻'} Closed ${sym}${p.exitPrice != null ? ` @ ₹${p.exitPrice.toFixed(2)}` : ''} · ${p.exitReason ?? 'exit'} · P&L ${p.pnlRupees >= 0 ? '+' : ''}₹${p.pnlRupees.toFixed(2)} (${where})`,
          p.pnlRupees >= 0 ? 'ok' : 'error',
        );
      }
    }
    announced.current = seen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.positions]);

  const handleManualRefresh = async () => {
    setManualRefreshing(true);
    try {
      await Promise.allSettled([
        fetch('/api/proxy/state', { cache: 'no-store' })
          .then((r) => r.json())
          .then((body) => {
            if (body && !body.error && !body.offline) {
              setState(body);
              if (body.autoTargetMode) setAutoTargetMode(body.autoTargetMode);
              if (body.autoTargetSymbol) setAutoTargetSymbol(body.autoTargetSymbol);
              setOfflineReason(null);
              setLastLiveAt(Date.now());
            }
          }),
        fetch('/api/market/overview', { cache: 'no-store' })
          .then((r) => r.json())
          .then((body) => {
            if (body) {
              setMarket(body);
              setMarketError(null);
              setLastLiveAt(Date.now());
            }
          }),
        fetch('/api/market/fno', { cache: 'no-store' })
          .then((r) => r.json())
          .then((body) => {
            if (body) {
              setMarketFno(body);
              setMarketFnoError(null);
            }
          }),
      ]);
      setNow(Date.now());
      showToast('Market & engine data refreshed', 'ok');
    } catch {
      showToast('Refresh encountered an error', 'error');
    } finally {
      setTimeout(() => setManualRefreshing(false), 350);
    }
  };

  // Poll state every 1.5 seconds from proxy. Any non-2xx means the data is not live.
  useEffect(() => {
    let mounted = true;
    const fetchState = async () => {
      let reason: string | null = null;
      let data: EngineState | null = null;
      try {
        const res = await fetch('/api/proxy/state', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body) {
          data = body as unknown as EngineState;
        } else if (res.status === 503 || body?.['offline'] === true) {
          reason = 'Engine unreachable';
        } else {
          reason = `${typeof body?.['error'] === 'string' ? body['error'] : 'Bad response'} (HTTP ${res.status})`;
        }
      } catch {
        reason = 'Dashboard server unreachable';
      }
      if (!mounted) return;
      setNow(Date.now());
      if (data) {
        setState(data);
        if (data.autoTargetMode) setAutoTargetMode(data.autoTargetMode);
        if (data.autoTargetSymbol) setAutoTargetSymbol(data.autoTargetSymbol);
        if (!hasInitForm.current) {
          hasInitForm.current = true;
          setFormTargetMode(data.autoTargetMode ?? 'ALL_SCANNED');
          setFormTargetSymbol(data.autoTargetSymbol ?? 'RELIANCE');
          setFormMinPrice(data.autoMinPrice ? String(data.autoMinPrice) : '');
          setFormMaxPrice(data.autoMaxPrice && data.autoMaxPrice < 500000 ? String(data.autoMaxPrice) : '');
          setFormStrategyMode(data.strategyMode ?? 'BOTH');
          setFormSizingMode(data.sizing?.mode ?? 'FIXED_BUDGET');
          setFormBudget(data.sizing?.budget ? String(data.sizing.budget) : '10000');
          setFormFixedQty(data.sizing?.fixedQty ? String(data.sizing.fixedQty) : '10');
          setFormRiskPct(data.sizing?.riskPct ? String(data.sizing.riskPct) : '1.0');
        }
        setOfflineReason(null);
        setLastLiveAt(Date.now());
      } else {
        setOfflineReason(reason);
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Market data comes from the dashboard's own routes and never needs the engine.
  useEffect(() => {
    let mounted = true;
    const load = async <T,>(path: string, set: (v: T) => void, setError: (e: string | null) => void) => {
      try {
        const res = await fetch(path, { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (!mounted) return;
        if (res.ok && body) {
          set(body as T);
          setError(null);
        } else {
          setError(typeof body?.['message'] === 'string' ? body['message'] : `HTTP ${res.status}`);
        }
      } catch {
        if (mounted) setError('Dashboard server unreachable');
      }
    };
    const overview = () => load<MarketOverview>('/api/market/overview', setMarket, setMarketError);
    const fno = () => load<MarketFno>('/api/market/fno', setMarketFno, setMarketFnoError);
    overview();
    fno();
    void load<Catalog>('/api/market/catalog', setCatalog, () => undefined);
    const a = setInterval(overview, 10_000);
    const b = setInterval(fno, 60_000);
    return () => {
      mounted = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, []);

  const handleCentralModeSwitch = async (target: 'PAPER' | 'LIVE') => {
    if (!state) return;
    if (target === state.mode) return;

    if (target === 'LIVE') {
      if (!state.auth?.hasTradingToken) {
        const proceed = window.confirm(
          '⚠️ Upstox Trading Token is not authenticated yet.\n\n' +
          'Would you like to open the Upstox login dialog now to authorize live trading?'
        );
        if (proceed && state.auth?.loginUrl) {
          window.location.href = state.auth.loginUrl;
        }
        return;
      }

      // The engine refuses to arm without this exact phrase; asking here just saves a round trip.
      const typed = window.prompt(
        '⚠️ SWITCH TO LIVE TRADING WITH REAL MONEY?\n\n' +
        '• Real orders will be routed directly to your Upstox account.\n' +
        '• Open paper positions stay on paper; only new entries go to Upstox.\n\n' +
        `Type exactly: ${ARM_PHRASE}`
      );
      if (typed === null) return;
      if (typed.trim() !== ARM_PHRASE) {
        showToast('Live switch cancelled — confirmation phrase did not match', 'error');
        return;
      }

      const r = await postEngine<{ mode?: string; error?: string }>('/mode/arm', { mode: 'LIVE', confirmation: ARM_PHRASE });
      if (!r.ok) {
        showToast(`❌ Live switch rejected: ${r.error}`, 'error');
        return;
      }
      setState((prev) => (prev ? { ...prev, mode: 'LIVE', isArmed: true } : null));
      window.dispatchEvent(new CustomEvent('tf:mode-change', { detail: { mode: 'LIVE' } }));
      showToast('🔴 LIVE TRADING ARMED — Real orders active');
    } else {
      const r = await postEngine<{ mode?: string; detail?: string }>('/mode/disarm', { mode: 'PAPER' });
      if (!r.ok) {
        showToast(`❌ Switch to PAPER FAILED: ${r.error} — engine may still be LIVE`, 'error');
        return;
      }
      setState((prev) => (prev ? { ...prev, mode: 'PAPER', isArmed: false } : null));
      window.dispatchEvent(new CustomEvent('tf:mode-change', { detail: { mode: 'PAPER' } }));
      showToast(r.data.detail ? `🟢 PAPER MODE — ${r.data.detail}` : '🟢 Switched to PAPER MODE — Zero-risk simulation');
    }
  };

  const handleSetAutoScope = async (mode: 'ALL_SCANNED' | 'SINGLE_STOCK', symbol?: string) => {
    const sym = (symbol ?? autoTargetSymbol ?? 'RELIANCE').toUpperCase().trim();
    setAutoTargetMode(mode);
    if (symbol) setAutoTargetSymbol(sym);

    const r = await postEngine<{ targetMode?: 'ALL_SCANNED' | 'SINGLE_STOCK'; targetSymbol?: string }>('/strategy/target', {
      targetMode: mode,
      targetSymbol: sym,
    });
    if (!r.ok) {
      showToast(`Target scope update failed: ${r.error}`, 'error');
      return;
    }
    setState((prev) =>
      prev
        ? {
            ...prev,
            autoTargetMode: r.data.targetMode ?? mode,
            autoTargetSymbol: r.data.targetSymbol ?? sym,
          }
        : null,
    );
    showToast(mode === 'SINGLE_STOCK' ? `🎯 Auto-trading locked to ${sym} only` : `🌐 Auto-trading scanning all universe stocks`);
  };

  const handleToggleAutoTrading = async () => {
    if (!state) return;
    const nextEnabled = !state.autoTrading;

    if (
      nextEnabled &&
      !window.confirm(
        `Turn ON Automated Trading in ${state.mode} mode?\n\n` +
        `• Target Scope: ${autoTargetMode === 'SINGLE_STOCK' ? `SINGLE STOCK (${autoTargetSymbol} ONLY)` : 'ALL WATCHED STOCKS (best setup by ensemble quality)'}\n` +
        `• Sizing: ${state.sizing.mode} (${state.sizing.mode === 'FIXED_BUDGET' ? `₹${state.sizing.budget?.toLocaleString('en-IN')}` : state.sizing.mode === 'FIXED_QTY' ? `${state.sizing.fixedQty} shares` : `${state.sizing.riskPct}% risk`})\n` +
        `• Strategy: ${state.strategyMode}\n\n` +
        `Click OK to activate automated execution.`
      )
    ) {
      return;
    }

    const r = await postEngine<{ autoTrading?: boolean; targetMode?: 'ALL_SCANNED' | 'SINGLE_STOCK'; targetSymbol?: string }>('/strategy/autotrade', {
      enabled: nextEnabled,
      targetMode: autoTargetMode,
      targetSymbol: autoTargetSymbol,
    });
    if (!r.ok) return showToast(`Auto-trading toggle FAILED: ${r.error}`, 'error');
    const next = typeof r.data.autoTrading === 'boolean' ? r.data.autoTrading : nextEnabled;
    setState((prev) =>
      prev
        ? {
            ...prev,
            autoTrading: next,
            autoTargetMode: r.data.targetMode ?? autoTargetMode,
            autoTargetSymbol: r.data.targetSymbol ?? autoTargetSymbol,
          }
        : null,
    );
    showToast(next ? `⚡ Auto-Trading ACTIVATED (${autoTargetMode === 'SINGLE_STOCK' ? `${autoTargetSymbol} Only` : 'All Universe'})` : '○ Auto-Trading PAUSED');
  };

  const handleSetStrategyMode = async (mode: 'INTRADAY' | 'SWING' | 'BOTH') => {
    const r = await postEngine<{ strategyMode?: EngineState['strategyMode'] }>('/strategy/mode', { mode });
    if (!r.ok) return showToast(`Strategy mode change FAILED: ${r.error}`, 'error');
    const next = r.data.strategyMode ?? mode;
    setState((prev) => (prev ? { ...prev, strategyMode: next } : null));
    showToast(`Trading mode set to: ${next}`);
  };

  const hasPendingChanges = Boolean(
    state &&
    (
      formTargetMode !== (state.autoTargetMode ?? 'ALL_SCANNED') ||
      (formTargetMode === 'SINGLE_STOCK' && formTargetSymbol.trim().toUpperCase() !== (state.autoTargetSymbol ?? 'RELIANCE').trim().toUpperCase()) ||
      (formMinPrice.trim() ? Number(formMinPrice) : 0) !== (state.autoMinPrice ?? 0) ||
      (formMaxPrice.trim() ? Number(formMaxPrice) : 500000) !== (state.autoMaxPrice ?? 500000) ||
      formStrategyMode !== (state.strategyMode ?? 'BOTH') ||
      formSizingMode !== (state.sizing?.mode ?? 'FIXED_BUDGET') ||
      (formSizingMode === 'FIXED_BUDGET' && (Number(formBudget) || 10000) !== (state.sizing?.budget ?? 10000)) ||
      (formSizingMode === 'FIXED_QTY' && (Number(formFixedQty) || 10) !== (state.sizing?.fixedQty ?? 10)) ||
      (formSizingMode === 'RISK_BASED' && (Number(formRiskPct) || 1) !== (state.sizing?.riskPct ?? 1))
    )
  );

  const handleApplyAllFilters = async () => {
    setApplyingFilters(true);
    const minP = formMinPrice.trim() ? Math.max(0, Number(formMinPrice)) : 0;
    const maxP = formMaxPrice.trim() ? Math.max(0, Number(formMaxPrice)) : 500000;
    const budgetVal = Math.max(100, Number(formBudget) || 10000);
    const qtyVal = Math.max(1, Math.floor(Number(formFixedQty) || 10));
    const riskVal = Math.min(5, Math.max(0.1, Number(formRiskPct) || 1));
    const sym = formTargetSymbol.trim().toUpperCase() || 'RELIANCE';

    const payload = {
      targetMode: formTargetMode,
      targetSymbol: sym,
      minPrice: minP,
      maxPrice: maxP,
      strategyMode: formStrategyMode,
      sizingMode: formSizingMode,
      budget: budgetVal,
      fixedQty: qtyVal,
      riskPct: riskVal,
    };

    const r = await postEngine<{
      ok?: boolean;
      autoTrading?: boolean;
      targetMode?: 'ALL_SCANNED' | 'SINGLE_STOCK';
      targetSymbol?: string;
      minPrice?: number;
      maxPrice?: number;
      strategyMode?: 'INTRADAY' | 'SWING' | 'BOTH';
      sizing?: { mode: 'FIXED_BUDGET' | 'FIXED_QTY' | 'RISK_BASED'; budget: number; fixedQty: number; riskPct: number };
    }>('/strategy/filters', payload);

    setApplyingFilters(false);
    if (!r.ok) {
      showToast(`Filter update FAILED: ${r.error}`, 'error');
      return;
    }

    setState((prev) => {
      if (!prev) return null;
      return {
        ...prev,
        autoTargetMode: r.data.targetMode ?? formTargetMode,
        autoTargetSymbol: r.data.targetSymbol ?? sym,
        autoMinPrice: r.data.minPrice ?? minP,
        autoMaxPrice: r.data.maxPrice ?? maxP,
        strategyMode: r.data.strategyMode ?? formStrategyMode,
        sizing: r.data.sizing ?? {
          mode: formSizingMode,
          budget: budgetVal,
          fixedQty: qtyVal,
          riskPct: riskVal,
        },
      };
    });

    setAutoTargetMode(r.data.targetMode ?? formTargetMode);
    setAutoTargetSymbol(r.data.targetSymbol ?? sym);

    showToast('✓ All trading filters and position sizing successfully applied!', 'ok');
  };

  const handleSetSizing = async (sizingMode: 'FIXED_BUDGET' | 'FIXED_QTY' | 'RISK_BASED', val: number) => {
    const payload: Record<string, unknown> = { mode: sizingMode };
    if (sizingMode === 'FIXED_BUDGET') payload.budget = val;
    if (sizingMode === 'FIXED_QTY') payload.fixedQty = val;
    if (sizingMode === 'RISK_BASED') payload.riskPct = val;

    const r = await postEngine('/sizing', payload);
    if (!r.ok) return showToast(`Sizing update FAILED: ${r.error}`, 'error');
    setState((prev) =>
      prev
        ? {
            ...prev,
            sizing: {
              ...prev.sizing,
              mode: sizingMode,
              ...(sizingMode === 'FIXED_BUDGET' ? { budget: val } : {}),
              ...(sizingMode === 'FIXED_QTY' ? { fixedQty: val } : {}),
              ...(sizingMode === 'RISK_BASED' ? { riskPct: val } : {}),
            },
          }
        : null,
    );
    showToast(`Sizing updated: ${sizingMode} (${val})`);
  };

  const handleAnalyzeStock = async (stock: ScoredStockItem) => {
    setDeepAnalysisStock(stock);
    setDeepAnalysisLoading(true);
    setDeepAnalysisVotes(null);
    setDeepAnalysisError(null);

    const style = state && !offlineReason && state.strategyMode === 'SWING' ? 'SWING' : 'INTRADAY';
    const r = await postMarket<{ consensus?: { votes?: MultiModelVote[] }; votes?: MultiModelVote[] }>('/api/market/analyze', {
      symbol: stock.symbol,
      style,
    });
    if (r.ok) {
      setDeepAnalysisVotes(r.data.consensus?.votes ?? r.data.votes ?? []);
    } else {
      setDeepAnalysisError(r.error);
    }
    setDeepAnalysisLoading(false);
  };

  const handleKill = async (level: 'SOFT' | 'HARD' | 'NUCLEAR') => {
    setKillPending(level);
    setKillError(null);
    const r = await postEngine<{ fired?: string }>('/kill', { level });
    setKillPending(null);
    if (!r.ok) {
      // Keep the modal open: the operator must see that NOTHING happened.
      setKillError(`KILL SWITCH ${level} FAILED — ${r.error}. Positions/orders may still be live. Verify on Upstox directly.`);
      showToast(`🛑 KILL SWITCH ${level} FAILED: ${r.error}`, 'error');
      return;
    }
    setKillModalOpen(false);
    showToast(`⚠️ Kill switch ${r.data.fired ?? level} accepted by engine — verify on Upstox`);
  };

  /** Add a scanner result to the engine's live watchlist (streamed, analysed, auto-eligible). */
  const handleWatchLive = async (symbol: string) => {
    const r = await postEngine<{ added?: string[]; failed?: Array<{ symbol: string; error: string }> }>('/watchlist/add', { symbol });
    if (!r.ok) return showToast(`Could not watch ${symbol}: ${r.error}`, 'error');
    showToast(`👁 ${symbol} added to the live watchlist — analysed every cycle`);
  };

  const handleExitPosition = async (positionId: string) => {
    const r = await postEngine('/positions/exit', { positionId });
    if (!r.ok) return showToast(`Exit FAILED for ${positionId}: ${r.error}`, 'error');
    showToast(`Position exit triggered for ${positionId}`);
  };

  const handleFnoToggle = async () => {
    if (!state?.fno) return;
    setFnoTogglePending(true);
    const r = await postEngine<{ enabled?: boolean }>('/fno/toggle', { enabled: !state.fno.enabled });
    setFnoTogglePending(false);
    if (!r.ok) return showToast(`F&O toggle FAILED: ${r.error}`, 'error');
    const enabled = typeof r.data.enabled === 'boolean' ? r.data.enabled : !state.fno.enabled;
    setState((prev) => (prev && prev.fno ? { ...prev, fno: { ...prev.fno, enabled } } : prev));
    showToast(`F&O trading ${enabled ? 'ENABLED' : 'DISABLED'}`);
  };

  const handleFnoAnalyze = async (symbol: string) => {
    setFnoResults((prev) => ({
      ...prev,
      [symbol]: { loading: true, error: null, analytics: prev[symbol]?.analytics ?? null, plan: null, rejected: [] },
    }));
    const r = await postMarket<{ analytics?: FnoAnalytics | null; plan?: FnoPlanView | null; rejected?: string[] }>('/api/market/fno/analyze', { symbol });
    setFnoResults((prev) => ({
      ...prev,
      [symbol]: r.ok
        ? { loading: false, error: null, analytics: r.data.analytics ?? null, plan: r.data.plan ?? null, rejected: r.data.rejected ?? [] }
        : { loading: false, error: r.error, analytics: prev[symbol]?.analytics ?? null, plan: null, rejected: [] },
    }));
  };

  const handleArm = async () => {
    setArmPending(true);
    setArmError(null);
    const r = await postEngine<{ mode?: string }>('/mode/arm', { confirmation: armPhrase });
    setArmPending(false);
    if (!r.ok) {
      setArmError(r.error);
      return;
    }
    setArmOpen(false);
    setArmPhrase('');
    showToast(`Live trading ARMED${r.data.mode ? ` — mode ${r.data.mode}` : ''}`);
  };

  const handleDisarm = async () => {
    const r = await postEngine<{ mode?: string }>('/mode/disarm', {});
    if (!r.ok) return showToast(`Disarm FAILED: ${r.error}`, 'error');
    showToast(`Disarmed${r.data.mode ? ` — mode ${r.data.mode}` : ''}`);
  };

  // Clears an operator halt (soft kill). The engine refuses while any position is ORPHANED.
  const handleResetHalt = async () => {
    const r = await postEngine('/halt/reset', {});
    if (!r.ok) return showToast(`Halt reset FAILED: ${r.error}`, 'error');
    showToast('Operator halt cleared — entries resume when every breaker is clear');
  };

  const selectedStock = useMemo(() => {
    const list = market?.watchlist ?? state?.watchlist ?? [];
    return list.find((w) => w.symbol === selectedSymbol) ?? list[0] ?? null;
  }, [market, state, selectedSymbol]);

  const isOffline = offlineReason !== null;

  const offlineBanner = isOffline ? (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        background: 'rgba(248,81,73,0.15)',
        border: '1px solid var(--danger)',
        borderRadius: 10,
        padding: '12px 18px',
      }}
    >
      <div>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--danger)' }}>⛔ Trading engine offline — market analysis above is still live</div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
          {offlineReason}.{' '}
          {lastLiveAt
            ? `The trading panels below are a stale snapshot from ${agoSec(lastLiveAt, now)} and are NOT live. Actions cannot be confirmed until the engine is back.`
            : 'No state has been received from the engine yet.'}{' '}
          {state && state.positions.length > 0
            ? `The last snapshot had ${state.positions.length} open position${state.positions.length === 1 ? '' : 's'}: check them directly on Upstox.`
            : 'Check open positions directly on Upstox.'}
        </div>
      </div>
      <button
        onClick={() => {
          setKillError(null);
          setKillModalOpen(true);
        }}
        style={{
          background: 'rgba(248,81,73,0.15)',
          border: '1px solid var(--danger)',
          color: 'var(--danger)',
          padding: '7px 14px',
          borderRadius: 6,
          fontWeight: 700,
          fontSize: 12,
          cursor: 'pointer',
        }}
      >
        🛑 KILL SWITCH (attempt)
      </button>
    </div>
  ) : null;

  const toastEl = toast ? (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      style={{
        position: 'fixed',
        top: 18,
        right: 24,
        maxWidth: 520,
        background: toast.kind === 'error' ? 'var(--danger)' : 'var(--accent)',
        color: '#fff',
        padding: '10px 18px',
        borderRadius: 6,
        fontWeight: 600,
        zIndex: 100000,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      }}
    >
      {toast.text}
    </div>
  ) : null;

  function renderKillModal() {
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'var(--panel-overlay)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 99999,
        }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--danger)',
            borderRadius: 12,
            boxShadow: 'var(--modal-shadow)',
            padding: 24,
            maxWidth: 480,
            width: '90%',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>🛑</span>
            <span>Emergency Kill Switch Confirmation</span>
          </div>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            Select the intervention level. Actions are irreversible and recorded in the hash-chained audit log.
          </p>

          {killError && (
            <div
              role="alert"
              style={{
                background: 'var(--danger)',
                color: '#fff',
                borderRadius: 6,
                padding: '10px 12px',
                fontSize: 12.5,
                fontWeight: 700,
                lineHeight: 1.4,
              }}
            >
              {killError}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, opacity: killPending ? 0.6 : 1 }}>
            <button
              disabled={killPending !== null}
              onClick={() => handleKill('SOFT')}
              style={{
                background: 'rgba(210,153,34,0.15)',
                border: '1px solid var(--warn)',
                color: 'var(--warn)',
                padding: '10px 14px',
                borderRadius: 6,
                fontWeight: 600,
                textAlign: 'left',
                cursor: killPending ? 'wait' : 'pointer',
              }}
            >
              <strong>1. SOFT KILL{killPending === 'SOFT' ? ' — sending…' : ''}</strong>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Stop all new entries immediately. Existing positions continue managing.</div>
            </button>

            <button
              disabled={killPending !== null}
              onClick={() => handleKill('HARD')}
              style={{
                background: 'rgba(248,81,73,0.15)',
                border: '1px solid var(--danger)',
                color: 'var(--danger)',
                padding: '10px 14px',
                borderRadius: 6,
                fontWeight: 600,
                textAlign: 'left',
                cursor: killPending ? 'wait' : 'pointer',
              }}
            >
              <strong>2. HARD KILL (FLATTEN){killPending === 'HARD' ? ' — sending…' : ''}</strong>
              <div style={{ fontSize: 11, opacity: 0.8 }}>Cancel all orders, cancel all GTT brackets, and force-exit all positions at market.</div>
            </button>

            <button
              disabled={killPending !== null}
              onClick={() => handleKill('NUCLEAR')}
              style={{
                background: 'var(--danger)',
                border: 'none',
                color: '#fff',
                padding: '10px 14px',
                borderRadius: 6,
                fontWeight: 700,
                textAlign: 'left',
                cursor: killPending ? 'wait' : 'pointer',
              }}
            >
              <strong>3. NUCLEAR KILL (ACCOUNT-LEVEL DISABLE){killPending === 'NUCLEAR' ? ' — sending…' : ''}</strong>
              <div style={{ fontSize: 11, opacity: 0.9 }}>Hard kill + Upstox account-level kill switch (POST /v2/user/kill-switch) for the traded segments.</div>
            </button>
          </div>

          <button
            onClick={() => {
              setKillModalOpen(false);
              setKillError(null);
            }}
            style={{
              background: 'transparent',
              border: '1px solid var(--line)',
              color: 'var(--muted)',
              padding: '8px',
              borderRadius: 6,
              fontWeight: 600,
              cursor: 'pointer',
              marginTop: 8,
            }}
          >
            {killError ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    );
  }


  const s = state;
  const topStock = market?.topStock ?? null;
  const rankedStocks = market?.rankedStocks ?? [];
  const fnoUnderlyings = marketFno?.underlyings ?? s?.fno?.underlyings ?? null;
  const fnoInstrument = s?.fno?.instrument ?? marketFno?.instrument ?? null;
  const autoOn = !!s && !isOffline && s.autoTrading;

  const sessionBadge = market?.session ? (
    <span
      style={{
        fontSize: 10.5,
        padding: '1px 6px',
        borderRadius: 4,
        fontWeight: 600,
        background: market.session.kind === 'today' ? 'rgba(63,185,80,0.15)' : 'rgba(210,153,34,0.15)',
        color: market.session.kind === 'today' ? 'var(--ok)' : 'var(--warn)',
      }}
    >
      {market.session.kind === 'today' ? 'Today' : `Last session · ${market.session.date}`}
    </span>
  ) : null;

  const dot = (color: string) => <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />;

  const statusStrip = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 10,
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '10px 16px',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {dot(marketError ? 'var(--danger)' : market ? 'var(--ok)' : 'var(--muted)')}
        <span style={{ fontWeight: 600 }}>Market data</span>
        <span style={{ color: 'var(--muted)' }}>
          {marketError
            ? `${marketError}${market ? ` — panels show data from ${agoSec(market.asOf, now)}` : ''}`
            : market ? `live from Upstox · updated ${agoSec(market.asOf, now)}` : 'loading…'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {dot(!s || isOffline ? 'var(--danger)' : 'var(--ok)')}
        <span style={{ fontWeight: 600 }}>Trading engine</span>
        <span style={{ color: 'var(--muted)' }}>{isOffline ? 'offline' : s ? 'online' : 'connecting…'}</span>
      </div>
    </div>
  );

  const killAttemptButton = (
    <button
      onClick={() => {
        setKillError(null);
        setKillModalOpen(true);
      }}
      style={{
        background: 'rgba(248,81,73,0.15)',
        border: '1px solid var(--danger)',
        color: 'var(--danger)',
        padding: '7px 14px',
        borderRadius: 6,
        fontWeight: 700,
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      🛑 KILL SWITCH (attempt)
    </button>
  );

  // The one switch that lets the engine place orders on its own. The engine is
  // the source of truth; with no engine there is nothing that could trade.
  const tradingHeader = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--panel)',
        border: `1px solid ${autoOn ? 'var(--ok)' : 'var(--line)'}`,
        borderRadius: 10,
        padding: '14px 18px',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Automated trading</div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, maxWidth: 760, lineHeight: 1.45 }}>
          {!s
            ? 'Unavailable: the trading engine is not running. Everything above works without it; placing orders needs the engine.'
            : isOffline
              ? 'Engine unreachable: the switch is locked until it is back.'
              : s.autoTrading
                ? `ON: the engine enters trades on its own in ${s.mode} mode.`
                : 'OFF: no automatic entries. Exits and the kill switch still work.'}
        </div>
      </div>
      <button
        role="switch"
        aria-checked={autoOn}
        disabled={!s || isOffline}
        onClick={handleToggleAutoTrading}
        style={{
          minWidth: 132,
          background: autoOn ? 'var(--ok)' : 'var(--panel-subtle)',
          border: `1px solid ${autoOn ? 'var(--ok)' : 'var(--line)'}`,
          color: autoOn ? '#ffffff' : !s || isOffline ? 'var(--muted)' : 'var(--fg)',
          borderRadius: 999,
          padding: '8px 16px',
          fontSize: 12.5,
          fontWeight: 700,
          cursor: !s || isOffline ? 'not-allowed' : 'pointer',
          boxShadow: autoOn ? '0 2px 8px rgba(16,185,129,0.25)' : 'none',
          transition: 'all 0.15s ease',
        }}
      >
        {!s || isOffline ? 'UNAVAILABLE' : autoOn ? '● ON' : '○ OFF'}
      </button>
    </div>
  );

  const tradingUnavailable = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'center',
        justifyContent: 'space-between',
        background: 'var(--panel)',
        border: '1px dashed var(--line)',
        borderRadius: 10,
        padding: '16px 18px',
      }}
    >
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, maxWidth: 820 }}>
        Positions, orders, P&L, live arming, sizing and circuit breakers appear here once the engine is running and connected.
        {isOffline && ' If the engine might still be running with open positions, check them directly on Upstox.'}
      </div>
      {isOffline && killAttemptButton}
    </div>
  );

  function renderOverviewEngineControls(s: EngineState) {
    const isPnlPositive = s.pnl.total >= 0;
    const isRealMoney = s.mode === 'LIVE' || s.mode === 'LIVE_ARMED' || s.isArmed;
    return (
      <div
        aria-disabled={isOffline}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          ...(isOffline ? { opacity: 0.35, filter: 'grayscale(1)', pointerEvents: 'none' as const, userSelect: 'none' as const } : {}),
        }}
      >
      {/* Upstox Authentication & Live API Connection Banner */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'linear-gradient(90deg, var(--panel) 0%, var(--panel-subtle) 100%)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '14px 20px',
          gap: 12,
          boxShadow: 'var(--card-shadow)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 22 }}>🇮🇳</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13.5, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--fg)' }}>Upstox Real-Time API Integration</span>
              {(() => {
                const src = s.telemetry.priceSource;
                const fresh = s.telemetry.feedStaleness !== null && s.telemetry.feedStaleness < 6000;
                const age = s.telemetry.feedStaleness === null ? 'never' : `${Math.round(s.telemetry.feedStaleness / 1000)}s ago`;
                const [label, tone] = src === 'WEBSOCKET' ? ['✓ Live ticks (WebSocket)', 'ok']
                  : src === 'REST_POLL' && fresh ? ['✓ Prices live via REST (every 2 s)', 'ok']
                    : src === 'REST_POLL' ? [`⚠ Prices slow — last ${age}`, 'warn']
                      : [`⚠ No prices — last ${age}`, 'danger'];
                return (
                  <span
                    title={s.telemetry.feedIssue ?? undefined}
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: `var(--${tone}-subtle)`,
                      border: `1px solid var(--${tone})`,
                      color: `var(--${tone})`,
                      fontWeight: 600,
                    }}
                  >
                    {label}
                  </span>
                );
              })()}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 3 }}>
              Analytics Token:{' '}
              {s.auth?.hasAnalyticsToken ? (
                <strong style={{ color: 'var(--ok)' }}>Loaded</strong>
              ) : (
                <strong style={{ color: 'var(--warn)' }}>{s.auth ? 'Missing' : 'Unknown'}</strong>
              )}{' '}
              · Trading OAuth:{' '}
              {s.auth?.hasTradingToken ? (
                <strong style={{ color: 'var(--ok)' }}>Authenticated (Active Session)</strong>
              ) : (
                <span style={{ color: 'var(--warn)' }}>Not authenticated (click to connect Upstox account)</span>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {s.auth?.loginUrl && (
            <a
              href={s.auth.loginUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                textDecoration: 'none',
                background: s.auth.hasTradingToken ? 'var(--panel-subtle)' : 'var(--accent)',
                border: s.auth.hasTradingToken ? '1px solid var(--line)' : 'none',
                color: s.auth.hasTradingToken ? 'var(--fg)' : '#ffffff',
                padding: '7px 16px',
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 650,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                boxShadow: s.auth.hasTradingToken ? 'none' : '0 1px 3px rgba(37,99,235,0.3)',
                transition: 'all 0.15s ease',
              }}
            >
              <span>🔑</span>
              <span>{s.auth.hasTradingToken ? 'Re-authenticate Upstox' : 'Login with Upstox'}</span>
            </a>
          )}
        </div>
      </div>

      {/* Top Header & Telemetry */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '16px 20px',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>TradeForger Enterprise</span>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 12,
                  background: isRealMoney ? 'rgba(248,81,73,0.2)' : 'rgba(63,185,80,0.2)',
                  color: isRealMoney ? 'var(--danger)' : 'var(--ok)',
                  border: `1px solid ${isRealMoney ? 'var(--danger)' : 'var(--ok)'}`,
                  fontWeight: 600,
                }}
              >
                {s.mode} TRADING
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Multi-Model AI Consensus · Intraday ORB & Swing Breakout Scanner · F&O Desk
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              borderRadius: 6,
              background: 'var(--panel-subtle)',
              border: '1px solid var(--line)',
              fontSize: 12,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: s.telemetry.feedStaleness !== null && s.telemetry.feedStaleness < 5000 ? 'var(--ok)' : 'var(--warn)',
                boxShadow: '0 0 8px var(--ok)',
              }}
            />
            <span>
              Upstox Feed: <strong>{s.telemetry.subscribedCount} Subs</strong>
            </span>
            <span style={{ color: 'var(--muted)' }}>
              ({s.telemetry.feedStaleness ? `${s.telemetry.feedStaleness}ms` : 'live'})
            </span>
          </div>

          <div
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              background: 'var(--panel-subtle)',
              border: '1px solid var(--line)',
              fontSize: 12,
            }}
          >
            IST: <strong className="mono">{s.telemetry.istTime}</strong> (NSE)
          </div>

          <button
            onClick={() => setKillModalOpen(true)}
            style={{
              background: 'var(--danger-subtle)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              padding: '7px 14px',
              borderRadius: 6,
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span>🛑</span>
            <span>KILL SWITCH</span>
          </button>
        </div>
      </div>

      {/* KPI Overview Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Total P&L Today</div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              marginTop: 4,
              color: isPnlPositive ? 'var(--ok)' : 'var(--danger)',
              fontFamily: 'monospace',
            }}
          >
            {isPnlPositive ? '+' : ''}₹{s.pnl.total.toFixed(2)}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Realised: ₹{s.pnl.realised.toFixed(2)} · Unrealised: ₹{s.pnl.unrealised.toFixed(2)}
          </div>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Active Auto Strategy</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--accent)' }}>{s.strategyMode}</span>
            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: s.autoTrading ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)', color: s.autoTrading ? 'var(--ok)' : 'var(--danger)' }}>
              {s.autoTrading ? 'RUNNING' : 'PAUSED'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            {s.strategyMode === 'BOTH' ? 'Intraday (15m ORB) + Swing (Daily EMA)' : s.strategyMode}
          </div>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Position Sizing Model</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--fg)', fontFamily: 'monospace' }}>
            {s.sizing.mode === 'FIXED_BUDGET' ? `₹${s.sizing.budget.toLocaleString('en-IN')}` : s.sizing.mode}
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Ceiling: ₹{s.limits.maxSpendPerTrade.toLocaleString('en-IN')} max per trade
          </div>
        </div>

        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
          <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>AI Consensus Engine</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>🤖 Multi-Model Ensemble</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Google Gemini + xAI Grok + Groq + Quant Ensemble
          </div>
        </div>
      </div>

      {/* ── UNIFIED AUTONOMOUS COMMAND HUB ── */}
      <div
        style={{
          background: 'var(--panel)',
          border: `1.5px solid ${isRealMoney ? 'rgba(248,81,73,0.4)' : 'rgba(63,185,80,0.4)'}`,
          borderRadius: 14,
          padding: '22px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          boxShadow: 'var(--card-shadow)',
          transition: 'all 0.2s ease',
        }}
      >
        {/* Row 1: Execution Mode & Master Auto-Trading Switch */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14 }}>
          {/* Centralized Mode Switcher */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Execution Mode:
            </span>
            <div
              style={{
                display: 'inline-flex',
                background: 'var(--panel-subtle)',
                border: '1px solid var(--line)',
                borderRadius: 999,
                padding: 3,
                gap: 4,
              }}
            >
              <button
                type="button"
                onClick={() => handleCentralModeSwitch('PAPER')}
                style={{
                  border: 'none',
                  background: !isRealMoney ? 'var(--ok)' : 'transparent',
                  color: !isRealMoney ? '#ffffff' : 'var(--muted)',
                  fontWeight: 750,
                  fontSize: 12.5,
                  padding: '7px 18px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.15s ease',
                  boxShadow: !isRealMoney ? '0 2px 8px rgba(63,185,80,0.3)' : 'none',
                }}
              >
                <span>🟢 PAPER SIMULATION</span>
              </button>

              <button
                type="button"
                onClick={() => handleCentralModeSwitch('LIVE')}
                style={{
                  border: 'none',
                  background: isRealMoney ? 'var(--danger)' : 'transparent',
                  color: isRealMoney ? '#ffffff' : 'var(--muted)',
                  fontWeight: 750,
                  fontSize: 12.5,
                  padding: '7px 18px',
                  borderRadius: 999,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  transition: 'all 0.15s ease',
                  boxShadow: isRealMoney ? '0 2px 8px rgba(248,81,73,0.3)' : 'none',
                }}
              >
                <span>🔴 LIVE TRADING</span>
              </button>
            </div>
            <span style={{ fontSize: 11.5, color: isRealMoney ? 'var(--danger)' : 'var(--ok)', fontWeight: 600 }}>
              {isRealMoney ? '● Real Upstox Orders' : '● Virtual Risk-Free'}
            </span>
          </div>

          {/* Master Auto-Trading Toggle */}
          <button
            type="button"
            onClick={handleToggleAutoTrading}
            style={{
              background: s.autoTrading ? 'rgba(63,185,80,0.15)' : 'var(--panel-subtle)',
              border: `1.5px solid ${s.autoTrading ? 'var(--ok)' : 'var(--line)'}`,
              color: s.autoTrading ? 'var(--ok)' : 'var(--muted)',
              borderRadius: 999,
              padding: '9px 22px',
              fontSize: 13,
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: s.autoTrading ? '0 0 14px rgba(63,185,80,0.35)' : 'none',
              transition: 'all 0.2s ease',
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: s.autoTrading ? 'var(--ok)' : 'var(--muted)',
                boxShadow: s.autoTrading ? '0 0 8px var(--ok)' : 'none',
              }}
            />
            <span>{s.autoTrading ? 'AUTOMATED TRADING: ACTIVE' : 'AUTOMATED TRADING: PAUSED'}</span>
          </button>
        </div>

        {/* Row 2: Applied Filters in Head */}
        <div
          style={{
            background: 'var(--panel-subtle)',
            borderRadius: 10,
            border: '1px solid var(--line)',
            padding: '12px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
            <div style={{ fontSize: 12, fontWeight: 750, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🏷️ APPLIED ACTIVE FILTERS (RUNNING IN ENGINE)</span>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'rgba(37,99,235,0.15)', color: 'var(--accent)', fontWeight: 700 }}>
                ACTIVE
              </span>
            </div>
            {hasPendingChanges && (
              <span style={{ fontSize: 11.5, color: '#f59e0b', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                <span>⚠️ Unapplied changes in form</span>
                <span style={{ color: 'var(--muted)' }}>(click "Apply Settings & Filters" below)</span>
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Target Scope Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Scope:</span>
              <strong style={{ color: s.autoTargetMode === 'SINGLE_STOCK' ? 'var(--accent)' : 'var(--fg)' }}>
                {s.autoTargetMode === 'SINGLE_STOCK' ? `🎯 Dedicated: ${s.autoTargetSymbol || 'RELIANCE'}` : '🌐 All Scanned Stocks'}
              </strong>
            </div>

            {/* Price Filter Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Price Range:</span>
              <strong style={{ color: (s.autoMinPrice || (s.autoMaxPrice && s.autoMaxPrice < 500000)) ? 'var(--accent)' : 'var(--fg)' }}>
                {(s.autoMinPrice || (s.autoMaxPrice && s.autoMaxPrice < 500000))
                  ? `₹${s.autoMinPrice || 0} – ₹${s.autoMaxPrice && s.autoMaxPrice < 500000 ? s.autoMaxPrice : 'Any'}`
                  : 'Any Price (No Range Limit)'}
              </strong>
            </div>

            {/* Sizing Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Sizing:</span>
              <strong>
                {s.sizing.mode === 'FIXED_BUDGET'
                  ? `💰 Fixed Amount: ₹${s.sizing.budget?.toLocaleString('en-IN') || '10,000'}`
                  : s.sizing.mode === 'FIXED_QTY'
                    ? `📦 Fixed Qty: ${s.sizing.fixedQty || 10} shares`
                    : `🛡️ Risk: ${s.sizing.riskPct || 1}% per trade`}
              </strong>
            </div>

            {/* Strategy Mode Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>Strategy:</span>
              <strong>
                {s.strategyMode === 'BOTH' ? '⚡ Dual (Intraday + Swing)' : s.strategyMode === 'INTRADAY' ? 'Intraday (15m ORB)' : 'Swing (Daily EMA)'}
              </strong>
            </div>

            {/* AI Models Badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, background: 'var(--panel)', border: '1px solid var(--line)', fontSize: 12 }}>
              <span style={{ color: 'var(--muted)' }}>AI Validation:</span>
              <strong style={{ color: 'var(--ok)' }}>
                🤖 Gemini + Grok + Groq + Quant Consensus
              </strong>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--line)', opacity: 0.7 }} />

        {/* ── CONFIGURATION & FILTERS FORM ── */}

        {/* Filter 1: Automated Target Scope */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🎯 Automated Trading Target Scope</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--panel-subtle)', border: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 600 }}>
                  Choose Either Mode
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Option 1: Scans all market stocks automatically · Option 2: Automated entry happens strictly on your selected stock.
              </div>
            </div>

            {/* Scope Selector Segmented Control */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => setFormTargetMode('ALL_SCANNED')}
                style={{
                  background: formTargetMode === 'ALL_SCANNED' ? 'var(--accent)' : 'var(--panel-subtle)',
                  color: formTargetMode === 'ALL_SCANNED' ? '#ffffff' : 'var(--fg)',
                  border: `1px solid ${formTargetMode === 'ALL_SCANNED' ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 8,
                  padding: '7px 16px',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: formTargetMode === 'ALL_SCANNED' ? '0 2px 6px rgba(37,99,235,0.3)' : 'none',
                }}
              >
                <span>🌐 All Scanned Stocks (Auto Ranking)</span>
              </button>

              <button
                type="button"
                onClick={() => setFormTargetMode('SINGLE_STOCK')}
                style={{
                  background: formTargetMode === 'SINGLE_STOCK' ? 'var(--accent)' : 'var(--panel-subtle)',
                  color: formTargetMode === 'SINGLE_STOCK' ? '#ffffff' : 'var(--fg)',
                  border: `1px solid ${formTargetMode === 'SINGLE_STOCK' ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 8,
                  padding: '7px 16px',
                  fontSize: 12.5,
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: formTargetMode === 'SINGLE_STOCK' ? '0 2px 6px rgba(37,99,235,0.3)' : 'none',
                }}
              >
                <span>🎯 Dedicated Single Stock</span>
              </button>
            </div>
          </div>

          {/* Sub-Panel: When Dedicated Single Stock is selected */}
          {formTargetMode === 'SINGLE_STOCK' && (
            <div
              style={{
                background: 'var(--panel-subtle)',
                border: '1px solid var(--accent)',
                borderRadius: 10,
                padding: '14px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
                marginTop: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14 }}>🔒</span>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--fg)' }}>
                    Selected Target Stock: <span style={{ color: 'var(--accent)', fontFamily: 'monospace', fontSize: 15 }}>{formTargetSymbol}</span>
                  </span>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(37,99,235,0.15)', color: 'var(--accent)', fontWeight: 600 }}>
                    Selected
                  </span>
                </div>
                <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  Automated entry will happen on <strong>{formTargetSymbol}</strong> only. All other stocks are skipped.
                </span>
              </div>

              {/* Quick Stock Selector Chips */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Quick Pick:</span>
                {['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'TCS', 'INFY', 'SBIN', 'TATAMOTORS', 'BHARTIARTL', 'LT', 'ITC'].map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setFormTargetSymbol(sym)}
                    style={{
                      background: formTargetSymbol === sym ? 'var(--accent)' : 'var(--panel)',
                      color: formTargetSymbol === sym ? '#ffffff' : 'var(--fg)',
                      border: `1px solid ${formTargetSymbol === sym ? 'var(--accent)' : 'var(--line)'}`,
                      borderRadius: 6,
                      padding: '4px 10px',
                      fontSize: 11.5,
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    {sym}
                  </button>
                ))}
              </div>

              {/* Searchable Autocomplete for any NSE Stock */}
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Or Search & Select Any NSE Symbol:</span>
                  <div style={{ position: 'relative', width: 280 }}>
                    <input
                      type="text"
                      placeholder="Type e.g. MARUTI, WIPRO, TATA..."
                      value={symbolSearchQuery}
                      onChange={(e) => setSymbolSearchQuery(e.target.value.toUpperCase())}
                      onFocus={() => {
                        if (symbolSearchResults.length > 0) setShowSearchDropdown(true);
                      }}
                      style={{
                        width: '100%',
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        borderRadius: 6,
                        padding: '7px 12px',
                        color: 'var(--fg)',
                        fontSize: 12.5,
                        textTransform: 'uppercase',
                        fontFamily: 'monospace',
                      }}
                    />
                    {isSearchingSymbols && (
                      <span style={{ position: 'absolute', right: 10, top: 8, fontSize: 11, color: 'var(--muted)' }}>
                        Searching...
                      </span>
                    )}
                  </div>
                </div>

                {/* Autocomplete Dropdown */}
                {showSearchDropdown && symbolSearchResults.length > 0 && (
                  <div
                    className="tf-dropdown"
                    style={{
                      position: 'absolute',
                      top: 36,
                      left: 245,
                      width: 320,
                      maxHeight: 220,
                      overflowY: 'auto',
                      background: 'var(--panel)',
                      border: '1px solid var(--accent)',
                      borderRadius: 8,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                      zIndex: 100,
                    }}
                  >
                    {symbolSearchResults.map((res) => (
                      <div
                        key={res.symbol}
                        onClick={() => {
                          setFormTargetSymbol(res.symbol);
                          setSymbolSearchQuery('');
                          setShowSearchDropdown(false);
                        }}
                        style={{
                          padding: '8px 12px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          borderBottom: '1px solid var(--line)',
                          cursor: 'pointer',
                          background: formTargetSymbol === res.symbol ? 'var(--panel-subtle)' : 'transparent',
                        }}
                      >
                        <span style={{ fontWeight: 700, fontFamily: 'monospace', color: 'var(--accent)' }}>
                          {res.symbol}
                        </span>
                        <span style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {res.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {formTargetMode === 'ALL_SCANNED' && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', background: 'var(--panel-subtle)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--line)' }}>
              🌐 <strong>All Scanned Stocks Active:</strong> Engine runs full algorithmic scanner (ORB, Supertrend, VWAP, Candlestick, Trend Momentum) across universe stocks, filters by your price range, and takes the top AI-consensus trade.
            </div>
          )}
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--line)', opacity: 0.7 }} />

        {/* Filter 2: Stock Price Filter (From & To) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🏷️ Stock Price Range Filter (₹)</span>
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'var(--panel-subtle)', border: '1px solid var(--line)', color: 'var(--muted)', fontWeight: 600 }}>
                  Price Boundary
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Only trade stocks whose price is between Min and Max. High-priced stocks (e.g. Maruti ₹12,000) or low-value penny stocks are excluded.
              </div>
            </div>

            {/* Quick Price Range Presets */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { label: '₹50 – ₹500', min: '50', max: '500' },
                { label: '₹100 – ₹1,000', min: '100', max: '1000' },
                { label: '₹200 – ₹2,500', min: '200', max: '2500' },
                { label: 'Clear (Any Price)', min: '', max: '' },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setFormMinPrice(p.min);
                    setFormMaxPrice(p.max);
                  }}
                  style={{
                    background: formMinPrice === p.min && formMaxPrice === p.max ? 'var(--accent)' : 'var(--panel-subtle)',
                    color: formMinPrice === p.min && formMaxPrice === p.max ? '#ffffff' : 'var(--fg)',
                    border: `1px solid ${formMinPrice === p.min && formMaxPrice === p.max ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 6,
                    padding: '5px 10px',
                    fontSize: 11.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Price Range Inputs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', background: 'var(--panel-subtle)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--line)' }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Min Price (₹):</span>
            <input
              type="number"
              min="0"
              placeholder="0 (No minimum)"
              value={formMinPrice}
              onChange={(e) => setFormMinPrice(e.target.value)}
              style={{
                width: 140,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '6px 10px',
                color: 'var(--fg)',
                fontSize: 12.5,
              }}
            />

            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)' }}>to</span>

            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Max Price (₹):</span>
            <input
              type="number"
              min="0"
              placeholder="500000 (No maximum)"
              value={formMaxPrice}
              onChange={(e) => setFormMaxPrice(e.target.value)}
              style={{
                width: 140,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '6px 10px',
                color: 'var(--fg)',
                fontSize: 12.5,
              }}
            />

            <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>
              {(formMinPrice || formMaxPrice)
                ? `Active filter: Only stocks from ₹${formMinPrice || 0} to ₹${formMaxPrice || '∞'}`
                : 'All stock prices eligible'}
            </span>
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--line)', opacity: 0.7 }} />

        {/* Filter 3: Position Sizing Options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)' }}>💰 Position Sizing Options</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Set how much capital or quantity to allocate per trade.
              </div>
            </div>

            {/* Sizing Mode Switcher */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[
                { id: 'FIXED_BUDGET', label: '💰 Fixed Amount (₹)' },
                { id: 'FIXED_QTY', label: '📦 Fixed Quantity' },
                { id: 'RISK_BASED', label: '🛡️ Risk % per Trade' },
              ].map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFormSizingMode(t.id as any)}
                  style={{
                    background: formSizingMode === t.id ? 'var(--accent)' : 'var(--panel-subtle)',
                    color: formSizingMode === t.id ? '#ffffff' : 'var(--fg)',
                    border: `1px solid ${formSizingMode === t.id ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sizing Configuration Inputs */}
          <div
            style={{
              background: 'var(--panel-subtle)',
              borderRadius: 8,
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              border: '1px solid var(--line)',
            }}
          >
            {formSizingMode === 'FIXED_BUDGET' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>
                  Selected: Fixed Capital Budget · ₹{Number(formBudget || 10000).toLocaleString('en-IN')} per trade
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Quick Presets:</span>
                  {[5000, 10000, 25000, 50000, 100000].map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => setFormBudget(String(amt))}
                      style={{
                        border: `1px solid ${formBudget === String(amt) ? 'var(--accent)' : 'var(--line)'}`,
                        background: formBudget === String(amt) ? 'var(--accent)' : 'var(--panel)',
                        color: formBudget === String(amt) ? '#ffffff' : 'var(--fg)',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      ₹{amt.toLocaleString('en-IN')}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Capital Amount: ₹</span>
                  <input
                    type="number"
                    min="100"
                    placeholder="10000"
                    value={formBudget}
                    onChange={(e) => setFormBudget(e.target.value)}
                    style={{
                      width: 150,
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: 'var(--fg)',
                      fontSize: 12.5,
                    }}
                  />
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>
                    (Shares allocated = Budget ÷ Stock Entry Price)
                  </span>
                </div>
              </div>
            )}

            {formSizingMode === 'FIXED_QTY' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>
                  Selected: Fixed Quantity · {formFixedQty || 10} shares/lots per trade
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Quick Presets:</span>
                  {[5, 10, 25, 50, 100, 250].map((qty) => (
                    <button
                      key={qty}
                      type="button"
                      onClick={() => setFormFixedQty(String(qty))}
                      style={{
                        border: `1px solid ${formFixedQty === String(qty) ? 'var(--accent)' : 'var(--line)'}`,
                        background: formFixedQty === String(qty) ? 'var(--accent)' : 'var(--panel)',
                        color: formFixedQty === String(qty) ? '#ffffff' : 'var(--fg)',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {qty} shares
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Shares Quantity:</span>
                  <input
                    type="number"
                    min="1"
                    placeholder="10"
                    value={formFixedQty}
                    onChange={(e) => setFormFixedQty(e.target.value)}
                    style={{
                      width: 120,
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: 'var(--fg)',
                      fontSize: 12.5,
                    }}
                  />
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>
                    (Orders exactly this number of shares or lots every trade)
                  </span>
                </div>
              </div>
            )}

            {formSizingMode === 'RISK_BASED' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--fg)' }}>
                  Selected: Risk-Based Sizing · {formRiskPct || 1}% capital risk per trade
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>Quick Presets:</span>
                  {[0.5, 1.0, 1.5, 2.0, 3.0].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => setFormRiskPct(String(pct))}
                      style={{
                        border: `1px solid ${formRiskPct === String(pct) ? 'var(--accent)' : 'var(--line)'}`,
                        background: formRiskPct === String(pct) ? 'var(--accent)' : 'var(--panel)',
                        color: formRiskPct === String(pct) ? '#ffffff' : 'var(--fg)',
                        borderRadius: 4,
                        padding: '4px 10px',
                        fontSize: 11.5,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>Risk % per trade:</span>
                  <input
                    type="number"
                    step="0.1"
                    max="5"
                    min="0.1"
                    placeholder="1.0"
                    value={formRiskPct}
                    onChange={(e) => setFormRiskPct(e.target.value)}
                    style={{
                      width: 110,
                      background: 'var(--panel)',
                      border: '1px solid var(--line)',
                      borderRadius: 4,
                      padding: '6px 10px',
                      color: 'var(--fg)',
                      fontSize: 12.5,
                    }}
                  />
                  <span style={{ fontSize: 11.5, color: 'var(--muted)', marginLeft: 6 }}>
                    (Sizing = Capital × Risk% ÷ StopLoss distance. Max 5% safety limit)
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--line)', opacity: 0.7 }} />

        {/* Filter 4: Strategy Profile */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Strategy Profile:</span>
            {(['INTRADAY', 'SWING', 'BOTH'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setFormStrategyMode(m)}
                style={{
                  background: formStrategyMode === m ? 'var(--accent)' : 'var(--panel-subtle)',
                  color: formStrategyMode === m ? '#ffffff' : 'var(--fg)',
                  border: `1px solid ${formStrategyMode === m ? 'var(--accent)' : 'var(--line)'}`,
                  borderRadius: 6,
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  boxShadow: formStrategyMode === m ? '0 1px 3px rgba(37,99,235,0.25)' : 'none',
                }}
              >
                {m === 'BOTH' ? '⚡ DUAL (Intraday + Swing)' : m}
              </button>
            ))}
          </div>

          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {formStrategyMode === 'BOTH' ? 'Intraday (5-min) and swing (daily) strategies both trade' : formStrategyMode === 'INTRADAY' ? 'Intraday strategies on 5-min bars · squared off by 15:10 IST' : 'Swing strategies on daily bars · delivery, held overnight'}
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: 1, background: 'var(--line)', opacity: 0.7 }} />

        {/* Master Action Bar: Apply Settings & Filters */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
            background: hasPendingChanges ? 'rgba(37,99,235,0.08)' : 'var(--panel-subtle)',
            border: `1.5px solid ${hasPendingChanges ? 'var(--accent)' : 'var(--line)'}`,
            borderRadius: 10,
            padding: '14px 18px',
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 750, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>⚙️ Save & Apply Filter Configuration</span>
              {hasPendingChanges && (
                <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, background: 'rgba(245,158,11,0.2)', color: '#d97706', fontWeight: 700 }}>
                  UNSAVED CHANGES
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Sets target scope, price limits, sizing model, and strategies into the live engine simultaneously.
            </div>
          </div>

          <button
            type="button"
            onClick={handleApplyAllFilters}
            disabled={applyingFilters}
            style={{
              background: hasPendingChanges ? 'linear-gradient(135deg, #2563eb, #1d4ed8)' : 'var(--accent)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 8,
              padding: '10px 24px',
              fontSize: 13.5,
              fontWeight: 800,
              cursor: applyingFilters ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              boxShadow: hasPendingChanges ? '0 0 14px rgba(37,99,235,0.4)' : 'none',
              transition: 'all 0.15s ease',
            }}
          >
            <span>{applyingFilters ? 'Applying...' : '✓ Apply Settings & Filters'}</span>
          </button>
        </div>
      </div>
      </div>
    );
  }

  function renderPositionsAndRisk(s: EngineState) {
    return (
      <div
        aria-disabled={isOffline}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          ...(isOffline ? { opacity: 0.35, filter: 'grayscale(1)', pointerEvents: 'none' as const, userSelect: 'none' as const } : {}),
        }}
      >
      {/* Positions and the engine's signal journal */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18 }}>
          {/* Active Positions Table */}
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Open Positions & GTT Brackets</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 10,
                    background: s.positions.length > 0 ? 'var(--ok-subtle)' : 'var(--panel-subtle)',
                    border: `1px solid ${s.positions.length > 0 ? 'var(--ok)' : 'var(--line)'}`,
                    color: s.positions.length > 0 ? 'var(--ok)' : 'var(--muted)',
                    fontWeight: 700,
                  }}
                >
                  {s.positions.length} active
                </span>
              </div>
            </div>

            {s.positions.length === 0 ? (
              <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                No active positions. Auto-trading engine scanning for qualified setups...
              </div>
            ) : (
              <div style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid var(--line)' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: 'var(--panel-subtle)', borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
                      <th style={{ padding: '8px 12px' }}>Symbol</th>
                      <th style={{ padding: '8px 12px' }}>Side / Qty</th>
                      <th style={{ padding: '8px 12px' }}>Avg / LTP</th>
                      <th style={{ padding: '8px 12px' }}>P&L</th>
                      <th style={{ padding: '8px 12px' }}>SL / Target</th>
                      <th style={{ padding: '8px 12px' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.positions.map((pos) => {
                      const isPos = pos.pnlRupees >= 0;
                      const isFo = pos.segment === 'FO' || pos.contract !== undefined;
                      const d = isFo ? 2 : 1;
                      return (
                        <tr key={pos.id} style={{ borderBottom: '1px solid var(--line-subtle)' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 600 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={isFo ? { fontFamily: 'monospace' } : undefined}>{pos.contract?.tradingSymbol ?? pos.symbol}</span>
                              {isFo && (
                                <span style={{ fontSize: 9.5, padding: '1px 5px', borderRadius: 4, background: 'rgba(74,158,255,0.15)', color: 'var(--accent)' }}>
                                  F&O
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                              {pos.contract
                                ? `${pos.underlyingSymbol ?? pos.symbol} · ${pos.contract.instrumentType}${pos.contract.strike !== null ? ` ${pos.contract.strike}` : ''} · exp ${pos.contract.expiry} · `
                                : ''}
                              {pos.product ? `${pos.product} · ` : ''}
                              {pos.state} · {pos.gttOrderId ? 'OCO ARMED' : 'NO GTT'}
                              {pos.broker && <> · <span style={{ fontWeight: 700, color: pos.broker === 'UPSTOX' ? 'var(--danger)' : 'var(--muted)' }}>{pos.broker === 'UPSTOX' ? 'LIVE' : 'PAPER'}</span></>}
                            </div>
                            {pos.exitReason && <div style={{ fontSize: 10, color: 'var(--warn)' }}>exit: {pos.exitReason}</div>}
                          </td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{ fontWeight: 700, color: pos.side === 'BUY' ? 'var(--ok)' : 'var(--danger)' }}>
                              {pos.side}
                            </span>{' '}
                            {pos.contract ? (
                              <>
                                {pos.contract.lots}L
                                <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                                  {' '}
                                  ({pos.filledQuantity}/{pos.quantity} qty)
                                </span>
                              </>
                            ) : (
                              <>x{pos.filledQuantity}</>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px', fontFamily: 'monospace' }}>
                            ₹{(pos.avgEntry ?? pos.entry).toFixed(d)} / ₹{pos.ltp.toFixed(d)}
                          </td>
                          <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontWeight: 600, color: isPos ? 'var(--ok)' : 'var(--danger)' }}>
                            {isPos ? '+' : ''}₹{pos.pnlRupees.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                            SL: ₹{pos.stopLoss.toFixed(isFo ? 2 : 0)} | T: ₹{pos.target.toFixed(isFo ? 2 : 0)}
                          </td>
                          <td style={{ padding: '9px 12px' }}>
                            {pos.state === 'ORPHANED' ? (
                              <button
                                onClick={() => setResolving(pos)}
                                title="The engine cannot account for this position and has halted entries. Check the broker, then record what is true."
                                style={{
                                  background: 'var(--danger)',
                                  color: '#ffffff',
                                  border: '1px solid var(--danger)',
                                  borderRadius: 4,
                                  padding: '3px 8px',
                                  fontSize: 10,
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                }}
                              >
                                Resolve
                              </button>
                            ) : (
                            <button
                              onClick={() => handleExitPosition(pos.id)}
                              style={{
                                background: 'rgba(248,81,73,0.15)',
                                color: 'var(--danger)',
                                border: '1px solid var(--danger)',
                                borderRadius: 4,
                                padding: '3px 8px',
                                fontSize: 10,
                                fontWeight: 600,
                                cursor: 'pointer',
                              }}
                            >
                              Exit
                            </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Live Signals & Multi-Model AI Consensus Panel */}
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Autonomous AI Consensus Signals</span>
                <span style={{ fontSize: 11, color: 'var(--ok)', background: 'rgba(63,185,80,0.12)', padding: '2px 6px', borderRadius: 4 }}>
                  3 Free Models Voting
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, maxHeight: 400, overflowY: 'auto' }}>
              {s.recentSignals.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  Scanning incoming ticks... Signals will appear here with instant multi-model AI consensus analysis.
                </div>
              ) : (
                s.recentSignals.map((sig) => {
                  const isLong = sig.side === 'BUY';
                  const verdictColor =
                    sig.ai.verdict === 'CONFIRM' ? 'var(--ok)' : sig.ai.verdict === 'CAUTION' ? 'var(--warn)' : 'var(--danger)';
                  return (
                    <div
                      key={sig.id}
                      style={{
                        background: 'var(--panel-subtle)',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        padding: '12px 14px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{sig.symbol}</span>
                          <span
                            style={{
                              padding: '1px 6px',
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 700,
                              background: isLong ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)',
                              color: isLong ? 'var(--ok)' : 'var(--danger)',
                            }}
                          >
                            {sig.side} ({sig.style})
                          </span>
                          <span style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                            Entry ₹{(sig.entry / 100).toFixed(1)} | SL ₹{(sig.stopLoss / 100).toFixed(1)} | T ₹{(sig.target / 100).toFixed(1)}
                          </span>
                        </div>

                        {/* AI Consensus Grade */}
                        <div
                          style={{
                            padding: '3px 8px',
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            background: `rgba(${sig.ai.verdict === 'CONFIRM' ? '63,185,80' : sig.ai.verdict === 'CAUTION' ? '210,153,34' : '248,81,73'}, 0.15)`,
                            color: verdictColor,
                            border: `1px solid ${verdictColor}`,
                          }}
                        >
                          {sig.ai.consensusGrade ? `GRADE ${sig.ai.consensusGrade}` : `AI: ${sig.ai.verdict}`} ({sig.ai.confidence}%)
                        </div>
                      </div>

                      {/* AI Models Votes Breakdown */}
                      {sig.ai.votes && sig.ai.votes.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2 }}>
                          {sig.ai.votes.map((v, i) => (
                            <span
                              key={i}
                              style={{
                                fontSize: 10,
                                padding: '2px 6px',
                                borderRadius: 4,
                                background: 'var(--panel-subtle)',
                                border: `1px solid ${v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)'}`,
                                color: v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)',
                              }}
                            >
                              {v.model.replace('free-', '').replace('-v1', '')}: {v.verdict} ({v.confidence}%)
                            </span>
                          ))}
                        </div>
                      )}

                      {/* AI Rationale Box */}
                      <div
                        style={{
                          marginTop: 2,
                          padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--panel-subtle)',
                          borderLeft: `3px solid ${verdictColor}`,
                          fontSize: 11.5,
                          lineHeight: 1.4,
                          color: 'var(--fg-secondary)',
                        }}
                      >
                        <span style={{ color: 'var(--muted)', fontWeight: 600 }}>🤖 AI Consensus: </span>
                        {sig.ai.rationale}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
      </div>

      {/* Safety & Circuit Breakers Full Panel */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Safety Circuit Breakers</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Evaluated on every tick and before every order. A trip halts new entries; each trip states whether exits remain allowed.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                background: s.breakers.allowEntries ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
                color: s.breakers.allowEntries ? 'var(--ok)' : 'var(--danger)',
                border: `1px solid ${s.breakers.allowEntries ? 'var(--ok)' : 'var(--danger)'}`,
              }}
            >
              {s.breakers.allowEntries ? 'ENTRIES ALLOWED' : 'ENTRIES HALTED'}
            </span>
            <span
              style={{
                padding: '3px 10px',
                borderRadius: 12,
                fontSize: 11,
                fontWeight: 700,
                background: s.breakers.allowExits ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
                color: s.breakers.allowExits ? 'var(--ok)' : 'var(--danger)',
                border: `1px solid ${s.breakers.allowExits ? 'var(--ok)' : 'var(--danger)'}`,
              }}
            >
              {s.breakers.allowExits ? 'EXITS ALLOWED' : 'EXITS BLOCKED'}
            </span>
          </div>
        </div>

        {s.breakers.trips.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {s.breakers.trips.map((t) => (
              <div
                key={t.id}
                style={{
                  background: 'rgba(248,81,73,0.08)',
                  border: '1px solid var(--danger)',
                  borderRadius: 6,
                  padding: '8px 12px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--danger)', fontFamily: 'monospace', fontSize: 11.5 }}>{t.id}</div>
                  <div style={{ marginTop: 2 }}>{t.detail}</div>
                </div>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {t.id === 'MANUAL_HALT' && !isOffline && (
                    <button
                      onClick={handleResetHalt}
                      style={{ fontSize: 10.5, fontWeight: 700, padding: '3px 8px', borderRadius: 4, border: '1px solid var(--warn)', background: 'transparent', color: 'var(--warn)', cursor: 'pointer' }}
                    >
                      Clear halt
                    </button>
                  )}
                  <span style={{ fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap', color: t.allowExits ? 'var(--warn)' : 'var(--danger)' }}>
                    {t.allowExits ? 'exits allowed' : 'EXITS BLOCKED'}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--ok)', marginBottom: 12 }}>✓ No breaker trips reported by the engine.</div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {[
            { label: 'Daily Loss Limit', val: `${s.limits.dailyLossLimitPct}% capital` },
            { label: 'Max Spend per Trade', val: `₹${s.limits.maxSpendPerTrade.toLocaleString('en-IN')}` },
            { label: 'Max Deployed Capital', val: `₹${s.limits.maxDeployed.toLocaleString('en-IN')}` },
            { label: 'Open Positions', val: `${s.positions.length}` },
            { label: 'Orders Today', val: `${s.telemetry.ordersCount}` },
            { label: 'Feed Staleness', val: s.telemetry.feedStaleness !== null ? `${s.telemetry.feedStaleness}ms` : 'no data' },
          ].map((b, i) => (
            <div
              key={i}
              style={{
                background: 'var(--panel-subtle)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 12,
              }}
            >
              <div style={{ color: 'var(--muted)', fontSize: 11 }}>{b.label}</div>
              <div style={{ fontWeight: 600, marginTop: 2 }}>{b.val}</div>
            </div>
          ))}
        </div>
      </div>
      </div>
    );
  }

  function renderDefaultOverviewCards() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 14 }}>
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Total P&L Today</div>
              <Hint term="P&L" explanation="Profit & Loss: Green means profit, red means loss. Realised is closed trades, Unrealised is open trades." />
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, color: 'var(--ok)', fontFamily: 'monospace' }}>
              ₹0.00
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Engine offline · 0 open trades
            </div>
          </div>

          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Active Auto Strategy</div>
              <Hint term="Strategy Modes" explanation="Intraday: 5-min strategies, squared off by 15:10 IST. Swing: daily-bar strategies, delivery positions held overnight. Both: either kind may enter. This controls what autonomous mode trades." />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: 'var(--accent)' }}>DUAL (Intraday + Swing)</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              15m ORB Breakout + Daily EMA
            </div>
          </div>

          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>Position Sizing Model</div>
              <Hint term="Position Sizing" explanation="Controls capital allocation per trade to protect your account balance against unexpected market moves." />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--fg)', fontFamily: 'monospace' }}>
              FIXED_BUDGET (₹10,000)
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Ceiling: ₹25,000 max per trade
            </div>
          </div>

          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 18px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ color: 'var(--muted)', fontSize: 12, fontWeight: 500 }}>AI Consensus Engine</div>
              <Hint term="3 AI Models" explanation="TradeForger runs 3 distinct free AI evaluation models in real-time to vote CONFIRM, CAUTION, or REJECT on trade signals." />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>🤖 3 Free AI Models</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
              Quant + Pattern + ML Expectancy (<strong style={{ color: 'var(--ok)' }}>0ms, $0 Cost</strong>)
            </div>
          </div>
        </div>

        {/* Upstox API feed card */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            padding: '14px 20px',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ fontSize: 24 }}>🇮🇳</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--fg)' }}>
                Upstox Real-Time Market Feed
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Web control plane connected to live NSE market quotes and options chains.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 999, background: 'var(--ok-subtle)', border: '1px solid var(--ok)', color: 'var(--ok)', fontWeight: 600 }}>
              ● Market Data Feed Active
            </span>
          </div>
        </div>
      </div>
    );
  }

  function renderTrading(s: EngineState) {
    return (
      <>
        {offlineBanner}
        {renderOverviewEngineControls(s)}
        {renderPositionsAndRisk(s)}
      </>
    );
  }

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {toastEl}

      {/* Prominent Live Data Status Bar with exact refreshed time */}
      <LiveStatusBar
        lastUpdated={lastLiveAt ?? market?.asOf ?? 0}
        feedStaleness={s?.telemetry.feedStaleness ?? null}
        subscribedCount={s?.telemetry.subscribedCount ?? 0}
        ordersCount={s?.telemetry.ordersCount ?? 0}
        isEngineConnected={!isOffline && s !== null}
        onRefresh={handleManualRefresh}
        refreshing={manualRefreshing}
      />

      {/* Accessible Tab Navigation Bar */}
      <nav
        role="tablist"
        aria-label="Trading terminal sections"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--line)',
          paddingBottom: 8,
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
        }}
      >
        {[
          { id: 'overview', label: '📊 Dashboard Overview', badge: null },
          { id: 'autopilot', label: '🤖 Autopilot', badge: s ? (s.autoTrading ? 'ON' : 'OFF') : null },
          { id: 'scanner', label: '🔍 Market Scanner', badge: '500+ Stocks' },
          { id: 'breakouts', label: '⚡ Breakout Radar', badge: `${rankedStocks.length > 0 ? rankedStocks.length : 'Top Setups'}` },
          { id: 'analysis', label: `🎯 Stock Deep Analysis`, badge: focusSymbol },
          { id: 'positions', label: '💼 Positions & Risk', badge: s?.positions.length ? `${s.positions.length} Active` : null },
          { id: 'fno', label: '📈 F&O Desk', badge: fnoInstrument ?? 'Index' },
        ].map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActiveTab(tab.id as TabId)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                padding: '9px 16px',
                borderRadius: 8,
                border: `1px solid ${isActive ? 'var(--accent)' : 'var(--line)'}`,
                background: isActive ? 'var(--accent)' : 'var(--panel)',
                color: isActive ? '#ffffff' : 'var(--fg)',
                fontWeight: isActive ? 700 : 600,
                fontSize: 13,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                boxShadow: isActive ? '0 2px 6px rgba(37,99,235,0.25)' : 'none',
                transition: 'all 0.15s ease',
              }}
            >
              <span>{tab.label}</span>
              {tab.badge && (
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: '2px 7px',
                    borderRadius: 999,
                    background: isActive ? 'rgba(255,255,255,0.25)' : 'var(--panel-subtle)',
                    color: isActive ? '#ffffff' : 'var(--muted)',
                    border: isActive ? 'none' : '1px solid var(--line)',
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* ── 1. OVERVIEW TAB ── */}
      <div
        role="tabpanel"
        id="panel-overview"
        aria-labelledby="tab-overview"
        tabIndex={0}
        hidden={activeTab !== 'overview'}
        style={{ display: activeTab === 'overview' ? 'flex' : 'none', flexDirection: 'column', gap: 18 }}
      >
        <BeginnerCard />

        {topStock && (
          <div
            style={{
              background: 'linear-gradient(90deg, var(--accent-subtle) 0%, var(--ok-subtle) 100%)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '16px 22px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              boxShadow: 'var(--card-shadow)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: 10,
                  background: 'var(--accent)',
                  color: '#ffffff',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontWeight: 800,
                  fontSize: 14,
                  boxShadow: '0 2px 8px rgba(37,99,235,0.3)',
                }}
              >
                <span>#1</span>
                <span style={{ fontSize: 9, letterSpacing: '0.05em' }}>TOP</span>
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 17, fontWeight: 800, color: 'var(--fg)' }}>{topStock.symbol}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>{topStock.name}</span>
                  <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--ok-subtle)', border: '1px solid var(--ok)', color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
                    BREAKOUT SCORE {topStock.score}/100
                  </span>
                  <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--accent-subtle)', border: '1px solid var(--accent)', color: 'var(--accent)', fontSize: 11, fontWeight: 600 }}>
                    {topStock.rvol}x RVOL
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-secondary)', marginTop: 4, fontFamily: 'monospace' }}>
                  LTP ₹{topStock.ltp.toFixed(2)} | Target 1: ₹{topStock.tradeSetup.target1.toFixed(2)} (+{((topStock.tradeSetup.target1 - topStock.tradeSetup.entry) / topStock.tradeSetup.entry * 100).toFixed(1)}%) | Stop Loss: ₹{topStock.tradeSetup.stopLoss.toFixed(2)} | R:R 1.5:1
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => handleAnalyzeStock(topStock)}
                style={{
                  background: 'var(--accent)',
                  border: 'none',
                  color: '#ffffff',
                  padding: '9px 18px',
                  borderRadius: 7,
                  fontWeight: 700,
                  fontSize: 12.5,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  boxShadow: '0 2px 6px rgba(37,99,235,0.25)',
                  transition: 'all 0.15s ease',
                }}
              >
                <span>⚡</span>
                <span>Deep AI Analysis</span>
              </button>
              <button
                onClick={() => handleSelectAndAnalyze(topStock.symbol)}
                style={{
                  background: 'var(--panel)',
                  border: '1px solid var(--line)',
                  color: 'var(--fg)',
                  padding: '9px 16px',
                  borderRadius: 7,
                  fontWeight: 650,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                Open Full Chart
              </button>
            </div>
          </div>
        )}

        {/* Quick Navigation Cards — hidden: the tab bar already reaches every section. Kept for reference.
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
          <div
            onClick={() => setActiveTab('scanner')}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '16px 18px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 20 }}>🔍</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-subtle)', padding: '2px 8px', borderRadius: 999 }}>
                500+ NSE STOCKS
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--fg)' }}>
              Market Scanner
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              Screen NIFTY 50, Midcap 100 & sectors with real-time volume surges and breakout filters.
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>Open Dedicated Scanner</span>
              <span>→</span>
            </div>
          </div>

          <div
            onClick={() => setActiveTab('breakouts')}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '16px 18px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 20 }}>⚡</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--ok)', background: 'var(--ok-subtle)', padding: '2px 8px', borderRadius: 999 }}>
                0-100 SCORE
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--fg)' }}>
              Breakout Radar
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              Track 15m ORB & SuperTrend setups with pre-calculated Entry, Target, and Stop Loss.
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>View Radar & Charts</span>
              <span>→</span>
            </div>
          </div>

          <div
            onClick={() => setActiveTab('analysis')}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '16px 18px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 20 }}>🤖</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', background: 'var(--accent-subtle)', padding: '2px 8px', borderRadius: 999 }}>
                3 AI MODELS
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--fg)' }}>
              AI Stock Deep Analysis
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              Real-time multi-model AI consensus, technical indicators, and R:R geometry for any stock.
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>Analyze Stock ({focusSymbol})</span>
              <span>→</span>
            </div>
          </div>

          <div
            onClick={() => setActiveTab('positions')}
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              padding: '16px 18px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 20 }}>🛡️</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--warn)', background: 'var(--warn-subtle)', padding: '2px 8px', borderRadius: 999 }}>
                SEBI SAFEGUARDS
              </span>
            </div>
            <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: 'var(--fg)' }}>
              Positions & Risk Controls
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>
              Track open trades, GTT OCO bracket orders, daily loss breakers, and kill switches.
            </div>
            <div style={{ marginTop: 10, fontSize: 11.5, fontWeight: 600, color: 'var(--warn)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>Manage Risk & Positions</span>
              <span>→</span>
            </div>
          </div>
        </div>
        */}

        {/* Overview Engine Controls (KPIs, Strategy, Arming, Upstox API) */}
        {s ? renderOverviewEngineControls(s) : renderDefaultOverviewCards()}
      </div>

      {/* ── 2. SCANNER TAB (Dedicated as requested) ── */}
      <div
        role="tabpanel"
        id="panel-scanner"
        aria-labelledby="tab-scanner"
        tabIndex={0}
        hidden={activeTab !== 'scanner'}
        style={{ display: activeTab === 'scanner' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>💡</span>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
              <strong>Market Scanner Tab:</strong> Filter 500+ NSE stocks in real-time across NIFTY 50, Midcap 100, and sectors. Click <strong>Analyze</strong> on any row to open the full AI Consensus and Technical chart.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Hint term="RVOL" explanation="Relative Volume: RVOL > 1.5x means trading volume is 50%+ higher than normal at this time of day. High volume validates breakouts.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is RVOL?</span>
            </Hint>
            <span style={{ color: 'var(--line)' }}>•</span>
            <Hint term="Breakout Setup" explanation="A breakout occurs when a stock breaks through a key resistance level with high volume, signaling a potential strong trend continuation.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is a Breakout?</span>
            </Hint>
          </div>
        </div>

        <MarketScanner
          catalog={catalog}
          onAnalyze={(symbol) => handleSelectAndAnalyze(symbol)}
          onWatch={handleWatchLive}
        />
      </div>

      {/* ── 3. BREAKOUTS TAB ── */}
      <div
        role="tabpanel"
        id="panel-breakouts"
        aria-labelledby="tab-breakouts"
        tabIndex={0}
        hidden={activeTab !== 'breakouts'}
        style={{ display: activeTab === 'breakouts' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>⚡</span>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
              <strong>Breakout Radar:</strong> Stocks ranked by institutional volume surge (RVOL) and technical breakout alignment. Click any stock row to preview its candlestick chart. Informational — autonomous entries rank setups by ensemble quality instead (see the Autopilot tab).
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Hint term="ORB" explanation="Opening Range Breakout: The high and low formed during the first 15 minutes of trading (09:15-09:30 IST). Breaking above the ORB high signals intraday bullish strength.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is ORB?</span>
            </Hint>
            <span style={{ color: 'var(--line)' }}>•</span>
            <Hint term="SuperTrend" explanation="A trend-following indicator based on ATR volatility. Green indicates an active bullish trend; red indicates bearish.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is SuperTrend?</span>
            </Hint>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 18 }}>
          {/* Watchlist Scanner Table */}
          <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
            <div
              style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--line)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Momentum Breakout Ranking (informational)</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Sorted by Breakout Score</span>
                {sessionBadge}
              </div>
            </div>

            <div style={{ overflowX: 'auto', maxHeight: 440 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
                    <th style={{ padding: '8px 12px' }}>Rank</th>
                    <th style={{ padding: '8px 12px' }}>Symbol</th>
                    <th style={{ padding: '8px 12px' }}>LTP (₹)</th>
                    <th style={{ padding: '8px 12px' }}>Change</th>
                    <th style={{ padding: '8px 12px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span>RVOL</span>
                        <Hint term="RVOL" explanation="Relative Volume compared to 20-day average. > 1.5x indicates heavy institutional buying." />
                      </span>
                    </th>
                    <th style={{ padding: '8px 12px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <span>Score</span>
                        <Hint term="Breakout Score" explanation="Proprietary 0-100 score combining Volume Surge, ORB range break, RSI momentum, and SuperTrend alignment." />
                      </span>
                    </th>
                    <th style={{ padding: '8px 12px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedStocks.map((item) => {
                    const isPos = item.changePct >= 0;
                    const isSelected = item.symbol === selectedStock?.symbol;
                    return (
                      <tr
                        key={item.instrumentKey}
                        onClick={() => {
                          setSelectedSymbol(item.symbol);
                          setFocusSymbol(item.symbol);
                        }}
                        style={{
                          borderBottom: '1px solid var(--line-subtle)',
                          cursor: 'pointer',
                          background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                          transition: 'background-color 0.1s ease',
                        }}
                      >
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: item.rank <= 2 ? 'var(--ok)' : 'var(--muted)' }}>
                          #{item.rank}
                        </td>
                        <td style={{ padding: '9px 12px', fontWeight: 650 }}>
                          <div style={{ color: 'var(--fg)' }}>{item.symbol}</div>
                          <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{item.name.slice(0, 16)}</div>
                        </td>
                        <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontWeight: 600 }}>
                          ₹{item.ltp.toFixed(2)}
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 700,
                              background: isPos ? 'var(--ok-subtle)' : 'var(--danger-subtle)',
                              color: isPos ? 'var(--ok)' : 'var(--danger)',
                            }}
                          >
                            {isPos ? '+' : ''}{item.changePct.toFixed(2)}%
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontSize: 11 }}>
                          {item.rvol}x
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <span
                            style={{
                              padding: '2px 8px',
                              borderRadius: 999,
                              fontWeight: 700,
                              fontSize: 11,
                              background: item.score >= 80 ? 'var(--ok-subtle)' : 'var(--accent-subtle)',
                              border: `1px solid ${item.score >= 80 ? 'var(--ok)' : 'var(--accent)'}`,
                              color: item.score >= 80 ? 'var(--ok)' : 'var(--accent)',
                            }}
                          >
                            {item.score}
                          </span>
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAnalyzeStock(item);
                            }}
                            style={{
                              background: 'var(--accent-subtle)',
                              border: '1px solid var(--accent)',
                              color: 'var(--accent-fg)',
                              borderRadius: 6,
                              padding: '4px 10px',
                              fontSize: 11,
                              fontWeight: 650,
                              cursor: 'pointer',
                            }}
                          >
                            Analyze
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {rankedStocks.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
                  {marketError ? `Market data unavailable: ${marketError}` : market ? 'No stock has enough 5-minute bars to rank yet.' : 'Loading market data…'}
                </div>
              )}
            </div>
          </div>

          {/* Interactive Chart Preview for Selected Symbol */}
          {selectedStock && (
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{selectedStock.symbol}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>₹{selectedStock.ltp.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 11, flexWrap: 'wrap' }}>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(74,158,255,0.15)', color: 'var(--accent)' }}>EMA20/50</span>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(210,153,34,0.15)', color: 'var(--warn)' }}>VWAP</span>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: 'var(--ok)' }}>Supertrend</span>
                  <button
                    onClick={() => handleSelectAndAnalyze(selectedStock.symbol)}
                    style={{
                      background: 'var(--accent)',
                      border: 'none',
                      color: '#ffffff',
                      borderRadius: 4,
                      padding: '2px 8px',
                      fontSize: 11,
                      fontWeight: 650,
                      cursor: 'pointer',
                    }}
                  >
                    Open Full AI Analysis →
                  </button>
                </div>
              </div>

              {/* Graphical Candlestick & Overlays Visualization */}
              <div
                style={{
                  height: 220,
                  background: 'var(--chart-bg)',
                  borderRadius: 8,
                  border: '1px solid var(--line)',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg viewBox="0 0 400 160" style={{ width: '100%', height: '100%' }}>
                  <line x1="0" y1="40" x2="400" y2="40" stroke="var(--chart-grid)" strokeDasharray="4" />
                  <line x1="0" y1="80" x2="400" y2="80" stroke="var(--chart-grid)" strokeDasharray="4" />
                  <line x1="0" y1="120" x2="400" y2="120" stroke="var(--chart-grid)" strokeDasharray="4" />

                  {/* VWAP Yellow Line */}
                  <path d="M 0 100 Q 100 85, 200 80 T 400 70" fill="none" stroke="var(--warn)" strokeWidth="1.5" strokeDasharray="3" />
                  {/* EMA 20 Blue Line */}
                  <path d="M 0 110 Q 120 70, 220 60 T 400 45" fill="none" stroke="var(--accent)" strokeWidth="2" />

                  {/* Candlesticks */}
                  <rect x="50" y="70" width="8" height="24" fill="var(--ok)" />
                  <line x1="54" y1="58" x2="54" y2="102" stroke="var(--ok)" strokeWidth="1" />

                  <rect x="90" y="65" width="8" height="20" fill="var(--ok)" />
                  <line x1="94" y1="55" x2="94" y2="92" stroke="var(--ok)" strokeWidth="1" />

                  <rect x="130" y="72" width="8" height="18" fill="var(--danger)" />
                  <line x1="134" y1="62" x2="134" y2="98" stroke="var(--danger)" strokeWidth="1" />

                  <rect x="170" y="60" width="8" height="25" fill="var(--ok)" />
                  <line x1="174" y1="48" x2="174" y2="92" stroke="var(--ok)" strokeWidth="1" />

                  <rect x="210" y="52" width="8" height="30" fill="var(--ok)" />
                  <line x1="214" y1="40" x2="214" y2="88" stroke="var(--ok)" strokeWidth="1" />

                  <rect x="250" y="48" width="8" height="20" fill="var(--ok)" />
                  <line x1="254" y1="36" x2="254" y2="76" stroke="var(--ok)" strokeWidth="1" />

                  <rect x="290" y="55" width="8" height="15" fill="var(--danger)" />
                  <line x1="294" y1="45" x2="294" y2="78" stroke="var(--danger)" strokeWidth="1" />

                  <rect x="330" y="40" width="8" height="28" fill="var(--ok)" />
                  <line x1="334" y1="30" x2="334" y2="74" stroke="var(--ok)" strokeWidth="1" />

                  {/* Current LTP marker */}
                  <circle cx="334" cy="40" r="4" fill="var(--ok)" />
                  <text x="345" y="44" fill="var(--ok)" fontSize="10" fontFamily="monospace" fontWeight="bold">
                    ₹{selectedStock.ltp.toFixed(1)}
                  </text>
                </svg>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── 4. ANALYSIS TAB ── */}
      <div
        role="tabpanel"
        id="panel-analysis"
        aria-labelledby="tab-analysis"
        tabIndex={0}
        hidden={activeTab !== 'analysis'}
        style={{ display: activeTab === 'analysis' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🎯</span>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
              <strong>Single Stock Deep Analysis:</strong> Multi-indicator breakdown with real-time voting by 3 free AI models (Quant, Pattern, Expectancy). Enter any NSE symbol below to evaluate.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Hint term="AI Models Consensus" explanation="3 independent AI evaluators check technical indicators, price pattern momentum, and statistical expectancy before scoring the setup.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>How AI Models Vote</span>
            </Hint>
            <span style={{ color: 'var(--line)' }}>•</span>
            <Hint term="ATR Stop Loss" explanation="Average True Range: Sets a volatility-adjusted Stop Loss so normal price noise doesn't trigger your stop prematurely.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is ATR SL?</span>
            </Hint>
          </div>
        </div>

        <div ref={analysisRef} style={{ scrollMarginTop: 12 }}>
          <StockAnalysis symbol={focusSymbol} onSymbolChange={setFocusSymbol} catalog={catalog} />
        </div>
      </div>

      {/* ── AUTOPILOT TAB: what autonomous mode is doing and why ── */}
      <div
        role="tabpanel"
        id="panel-autopilot"
        aria-labelledby="tab-autopilot"
        tabIndex={0}
        hidden={activeTab !== 'autopilot'}
        style={{ display: activeTab === 'autopilot' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        {s ? (
          <>
            <TradeBlotter
              positions={s.positions}
              realisedToday={s.pnl.realised}
              unrealised={s.pnl.unrealised}
              now={now}
              onExit={(id) => void handleExitPosition(id)}
              onResolve={(p) => setResolving(s.positions.find((x) => x.id === p.id) ?? null)}
            />
            {activeTab === 'autopilot' && <AutoPilot onToast={showToast} />}
          </>
        ) : tradingUnavailable}
      </div>

      {/* ── 5. POSITIONS & RISK TAB ── */}
      <div
        role="tabpanel"
        id="panel-positions"
        aria-labelledby="tab-positions"
        tabIndex={0}
        hidden={activeTab !== 'positions'}
        style={{ display: activeTab === 'positions' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>🛡️</span>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
              <strong>Positions & Risk Controls:</strong> Live open trades are monitored tick-by-tick with automated GTT OCO brackets. Safety circuit breakers enforce maximum loss rules.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Hint term="GTT OCO" explanation="Good Till Triggered - One-Cancels-Other: If Target profit is executed, the Stop Loss order is automatically cancelled. Capital is 100% safeguarded.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is GTT OCO?</span>
            </Hint>
            <span style={{ color: 'var(--line)' }}>•</span>
            <Hint term="Safety Breakers" explanation="Automated circuit breakers halt entries when daily loss limit is hit or market volatility exceeds thresholds.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>Safety Rules</span>
            </Hint>
          </div>
        </div>

        {s ? renderPositionsAndRisk(s) : tradingUnavailable}
      </div>

      {/* ── 6. F&O DESK TAB ── */}
      <div
        role="tabpanel"
        id="panel-fno"
        aria-labelledby="tab-fno"
        tabIndex={0}
        hidden={activeTab !== 'fno'}
        style={{ display: activeTab === 'fno' ? 'flex' : 'none', flexDirection: 'column', gap: 16 }}
      >
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 18 }}>📈</span>
            <div style={{ fontSize: 12, color: 'var(--fg-secondary)', lineHeight: 1.4 }}>
              <strong>Futures & Options (F&O) Desk:</strong> Real-time option-chain analytics for NIFTY, BANKNIFTY, FINNIFTY, and key derivatives. Evaluates Put-Call Ratio (PCR), Max Pain, and Open Interest.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Hint term="PCR" explanation="Put-Call Ratio: PCR > 1.0 indicates bullish support (more put writing). PCR < 0.7 indicates bearish resistance (more call writing).">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is PCR?</span>
            </Hint>
            <span style={{ color: 'var(--line)' }}>•</span>
            <Hint term="Max Pain" explanation="The strike price where option buyers lose the most money at expiry, often acting as a price attractor.">
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600 }}>What is Max Pain?</span>
            </Hint>
          </div>
        </div>

        {/* F&O Desk Content */}
        <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
          <div
            style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--line)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>F&O Derivatives Desk</span>
              {fnoInstrument && (
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'rgba(74,158,255,0.15)', color: 'var(--accent)' }}>
                  {fnoInstrument}
                </span>
              )}
              <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Index options / futures · option-chain analytics</span>
              {marketFno && (
                <span style={{ fontSize: 11, fontWeight: 600, color: marketFnoError ? 'var(--danger)' : 'var(--muted)' }}>
                  {marketFnoError ? `refresh failed (${marketFnoError}) · data from ${agoSec(marketFno.asOf, now)}` : `updated ${agoSec(marketFno.asOf, now)}`}
                </span>
              )}
            </div>
            {s?.fno && !isOffline && (
              <button
                onClick={handleFnoToggle}
                disabled={fnoTogglePending}
                style={{
                  background: s.fno.enabled ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)',
                  border: `1px solid ${s.fno.enabled ? 'var(--ok)' : 'var(--danger)'}`,
                  color: s.fno.enabled ? 'var(--ok)' : 'var(--danger)',
                  borderRadius: 6,
                  padding: '6px 14px',
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: fnoTogglePending ? 'wait' : 'pointer',
                }}
              >
                {fnoTogglePending ? '… updating' : s.fno.enabled ? '● F&O TRADING ENABLED' : '○ F&O TRADING DISABLED'}
              </button>
            )}
          </div>

          {!fnoUnderlyings ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>
              {marketFnoError ? `Option-chain data unavailable: ${marketFnoError}` : 'Loading option chains…'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 14 }}>
              {fnoUnderlyings.length === 0 ? (
                <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>No F&O underlyings configured.</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                  {fnoUnderlyings.map((u) => {
                    const result = fnoResults[u.symbol];
                    const a = u.analytics ?? result?.analytics ?? null;
                    const biasColor = a?.bias === 'BULLISH' ? 'var(--ok)' : a?.bias === 'BEARISH' ? 'var(--danger)' : 'var(--muted)';
                    const biasRgb = a?.bias === 'BULLISH' ? '63,185,80' : a?.bias === 'BEARISH' ? '248,81,73' : '139,150,165';
                    return (
                      <div
                        key={u.symbol}
                        style={{
                          background: 'var(--panel-subtle)',
                          border: '1px solid var(--line)',
                          borderRadius: 8,
                          padding: '12px 14px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                          <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontWeight: 700, fontSize: 14 }}>{u.symbol}</span>
                              <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 600 }}>{fmt(u.spot ?? a?.spot ?? null)}</span>
                              {a && (
                                <span
                                  style={{
                                    padding: '1px 6px',
                                    borderRadius: 4,
                                    fontSize: 10,
                                    fontWeight: 700,
                                    background: `rgba(${biasRgb},0.15)`,
                                    color: biasColor,
                                    border: `1px solid ${biasColor}`,
                                  }}
                                >
                                  {a.bias} {a.biasScore > 0 ? '+' : ''}
                                  {a.biasScore}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
                              Exp {u.expiry ?? '—'} · Lot {u.lotSize ?? '—'} · signals from <span className="mono" style={{ fontSize: 10.5 }}>{u.signalKey}</span>
                            </div>
                          </div>
                          <button
                            onClick={() => handleFnoAnalyze(u.symbol)}
                            disabled={result?.loading}
                            style={{
                              background: 'rgba(74,158,255,0.15)',
                              border: '1px solid var(--accent)',
                              color: 'var(--accent)',
                              borderRadius: 4,
                              padding: '3px 8px',
                              fontSize: 10,
                              fontWeight: 650,
                              cursor: result?.loading ? 'wait' : 'pointer',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {result?.loading ? 'Analyzing…' : 'Analyze'}
                          </button>
                        </div>

                        {u.error && (
                          <div style={{ fontSize: 11.5, color: 'var(--danger)', background: 'rgba(248,81,73,0.1)', borderRadius: 6, padding: '6px 10px' }}>
                            {u.error}
                          </div>
                        )}

                        {a ? (
                          <>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                              <Metric label="ATM" value={fmt(a.atmStrike, 0)} />
                              <Metric label="PCR OI / VOL" value={`${fmt(a.pcrOi)} / ${fmt(a.pcrVolume)}`} />
                              <Metric label="MAX PAIN" value={fmt(a.maxPain, 0)} />
                              <Metric label="CALL WALL" value={fmt(a.callWall, 0)} color="var(--danger)" />
                              <Metric label="PUT WALL" value={fmt(a.putWall, 0)} color="var(--ok)" />
                              <Metric label="ATM IV" value={a.atmIv === null ? '—' : `${fmt(a.atmIv, 1)}%`} />
                              <Metric label="IV SKEW" value={a.ivSkew === null ? '—' : `${fmt(a.ivSkew, 1)}`} />
                              <Metric label="STRADDLE" value={fmt(a.straddle)} />
                              <Metric label="EXP. MOVE" value={a.expectedMovePct === null ? '—' : `±${fmt(a.expectedMovePct)}%`} />
                            </div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10 }}>
                              <span style={{ padding: '2px 6px', borderRadius: 4, border: `1px solid ${BUILDUP_COLOR[a.callBuildup]}`, color: BUILDUP_COLOR[a.callBuildup] }}>
                                CE: {a.callBuildup.replace('_', ' ')}
                              </span>
                              <span style={{ padding: '2px 6px', borderRadius: 4, border: `1px solid ${BUILDUP_COLOR[a.putBuildup]}`, color: BUILDUP_COLOR[a.putBuildup] }}>
                                PE: {a.putBuildup.replace('_', ' ')}
                              </span>
                              <span style={{ marginLeft: 'auto', color: 'var(--muted)' }}>updated {agoSec(a.updatedAt, now)}</span>
                            </div>
                            {a.notes.length > 0 && (
                              <div style={{ fontSize: 11, color: '#c9d1d9', lineHeight: 1.4 }}>
                                {a.notes.map((n, i) => (
                                  <div key={i}>• {n}</div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : (
                          !u.error && <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>No option-chain analytics yet.</div>
                        )}

                        {result && !result.loading && (
                          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>Analyze result</div>
                            {result.error && <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{result.error}</div>}
                            {result.plan && <FnoPlanDetail plan={result.plan} />}
                            {result.plan && (
                              <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                                Sized at 1 lot for reference. The engine sizes real trades from your capital and limits.
                              </div>
                            )}
                            {!result.error && !result.plan && result.rejected.length === 0 && (
                              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>No setup generated.</div>
                            )}
                            {result.rejected.length > 0 && (
                              <div style={{ fontSize: 11.5, color: 'var(--warn)', lineHeight: 1.4 }}>
                                <div style={{ fontWeight: 600 }}>No trade — rejected:</div>
                                {result.rejected.map((r, i) => (
                                  <div key={i}>• {r}</div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Recent F&O plans */}
              {s?.fno && (
              <div>
                <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6, color: 'var(--muted)' }}>Recent F&O plans</div>
                {s.fno.plans.length === 0 ? (
                  <div style={{ padding: 12, textAlign: 'center', color: 'var(--muted)', fontSize: 12 }}>No plans yet.</div>
                ) : (
                  <div style={{ overflowX: 'auto', maxHeight: 360 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
                          <th style={{ padding: '8px 12px' }}>Time</th>
                          <th style={{ padding: '8px 12px' }}>Contract</th>
                          <th style={{ padding: '8px 12px' }}>Side / Lots</th>
                          <th style={{ padding: '8px 12px' }}>Entry / SL / Target</th>
                          <th style={{ padding: '8px 12px' }}>Cost / Max loss</th>
                          <th style={{ padding: '8px 12px' }}>Conf</th>
                          <th style={{ padding: '8px 12px' }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.fno.plans.map((p) => (
                          <tr key={p.id} style={{ borderBottom: '1px solid var(--line-subtle)' }}>
                            <td style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                              {new Date(p.createdAt).toLocaleTimeString('en-IN', { hour12: false })}
                            </td>
                            <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                              <div style={{ fontFamily: 'monospace' }}>{p.contract.tradingSymbol}</div>
                              <div style={{ fontSize: 10, color: 'var(--muted)' }}>
                                {p.symbol} · exp {p.contract.expiry}
                              </div>
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              <span style={{ fontWeight: 700, color: p.side === 'BUY' ? 'var(--ok)' : 'var(--danger)' }}>{p.side}</span> {p.lots}L
                              <span style={{ fontSize: 10, color: 'var(--muted)' }}> ({p.quantity})</span>
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11 }}>
                              {fmt(p.premium.entry)} / <span style={{ color: 'var(--danger)' }}>{fmt(p.premium.stopLoss)}</span> /{' '}
                              <span style={{ color: 'var(--ok)' }}>{fmt(p.premium.target)}</span>
                            </td>
                            <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: 11 }}>
                              {inr(p.costRupees, 0)} / <span style={{ color: 'var(--danger)' }}>{inr(p.maxLossRupees, 0)}</span>
                            </td>
                            <td style={{ padding: '8px 12px', fontSize: 11 }}>{p.confidence}%</td>
                            <td style={{ padding: '8px 12px' }}>
                              <span
                                title={p.rejectReason ?? undefined}
                                style={{
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  fontSize: 10,
                                  fontWeight: 700,
                                  background: PLAN_STATUS_STYLE[p.status].bg,
                                  color: PLAN_STATUS_STYLE[p.status].fg,
                                }}
                              >
                                {p.status}
                              </span>
                              {p.rejectReason && <div style={{ fontSize: 10, color: 'var(--danger)', marginTop: 2 }}>{p.rejectReason}</div>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Single Stock Deep AI Analysis Modal */}
      {deepAnalysisStock && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'var(--panel-overlay)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 14,
              boxShadow: 'var(--modal-shadow)',
              padding: 24,
              maxWidth: 640,
              width: '92%',
              maxHeight: '90vh',
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg)' }}>{deepAnalysisStock.symbol}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{deepAnalysisStock.name}</span>
                <span style={{ padding: '2px 8px', borderRadius: 999, background: 'var(--ok-subtle)', border: '1px solid var(--ok)', color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
                  SCORE {deepAnalysisStock.score}/100
                </span>
              </div>
              <button
                onClick={() => setDeepAnalysisStock(null)}
                style={{ background: 'transparent', border: 'none', color: 'var(--muted)', fontSize: 18, cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            {/* Calculated Trade Setup Geometry */}
            <div style={{ background: 'var(--panel-subtle)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--accent)', marginBottom: 8 }}>
                Calculated Entry & Risk Geometry (1.5x ATR Intraday / 2.5x ATR Swing)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center', fontFamily: 'monospace' }}>
                <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>ENTRY PRICE</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.entry.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--danger)' }}>STOP LOSS</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.stopLoss.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'var(--ok-subtle)', border: '1px solid var(--ok)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--ok)' }}>TARGET 1 (1:1.5)</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.target1.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'var(--ok-subtle)', border: '1px solid var(--ok)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--ok)' }}>TARGET 2 (1:2.5)</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.target2.toFixed(2)}
                  </div>
                </div>
              </div>

              <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                Risk Per Share: ₹{deepAnalysisStock.tradeSetup.riskPerShare.toFixed(2)} · Trailing SL Gap: ₹{deepAnalysisStock.tradeSetup.trailingGap.toFixed(2)}
              </div>
            </div>

            {/* 3 Free AI Models Voting Breakdown */}
            <div style={{ background: 'var(--panel-subtle)', border: '1px solid var(--line)', borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--ok)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🤖 3 Free Real-Time AI Models Analysis</span>
                {deepAnalysisLoading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>(analyzing...)</span>}
              </div>

              {deepAnalysisVotes ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {deepAnalysisVotes.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        borderRadius: 8,
                        padding: '10px 14px',
                        borderLeft: `3px solid ${v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)'}`,
                        fontSize: 11.5,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, marginBottom: 2 }}>
                        <span style={{ color: 'var(--fg)' }}>Model: {v.model}</span>
                        <span style={{ color: v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)' }}>
                          {v.verdict} ({v.confidence}%)
                        </span>
                      </div>
                      <div style={{ color: 'var(--fg-secondary)', lineHeight: 1.4 }}>{v.rationale}</div>
                    </div>
                  ))}
                </div>
              ) : deepAnalysisError ? (
                <div role="alert" style={{ fontSize: 12, color: 'var(--danger)', textAlign: 'center', padding: 12 }}>
                  Analysis failed: {deepAnalysisError}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center', padding: 12 }}>
                  Evaluating technical indicators, pattern structure, and statistical expectancy...
                </div>
              )}
            </div>

            <button
              onClick={() => setDeepAnalysisStock(null)}
              style={{
                background: 'var(--accent)',
                border: 'none',
                color: '#ffffff',
                padding: '10px',
                borderRadius: 8,
                fontWeight: 700,
                cursor: 'pointer',
                boxShadow: '0 2px 6px rgba(37,99,235,0.25)',
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {killModalOpen && renderKillModal()}
      {resolving && <OrphanResolver position={resolving} onClose={() => setResolving(null)} onDone={showToast} />}
    </div>
  );
}
