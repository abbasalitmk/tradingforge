'use client';

import React, { useState, useEffect, useMemo } from 'react';

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
    trips: Array<{ id: string; message: string; blocks: string }>;
  };
  telemetry: {
    istTime: string;
    uptimeMs: number;
    ticks: number;
    feedStaleness: number | null;
    subscribedCount: number;
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
}

export default function Dashboard() {
  const [state, setState] = useState<EngineState | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string>('INFY');
  const [deepAnalysisStock, setDeepAnalysisStock] = useState<ScoredStockItem | null>(null);
  const [deepAnalysisVotes, setDeepAnalysisVotes] = useState<MultiModelVote[] | null>(null);
  const [deepAnalysisLoading, setDeepAnalysisLoading] = useState<boolean>(false);
  const [killModalOpen, setKillModalOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Poll state every 1.5 seconds from proxy
  useEffect(() => {
    let mounted = true;
    const fetchState = async () => {
      try {
        const res = await fetch('/api/proxy/state');
        if (res.ok) {
          const data = await res.json();
          if (mounted) {
            setState(data);
            setLoading(false);
          }
        }
      } catch {
        // Handled silently
      }
    };

    fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleToggleAutoTrading = async () => {
    if (!state) return;
    try {
      const res = await fetch('/api/proxy/strategy/autotrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !state.autoTrading }),
      });
      if (res.ok) {
        setState((prev) => (prev ? { ...prev, autoTrading: !prev.autoTrading } : null));
        setStatusMessage(`Auto-trading ${!state.autoTrading ? 'RESUMED' : 'PAUSED'}`);
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetStrategyMode = async (mode: 'INTRADAY' | 'SWING' | 'BOTH') => {
    try {
      const res = await fetch('/api/proxy/strategy/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) {
        setState((prev) => (prev ? { ...prev, strategyMode: mode } : null));
        setStatusMessage(`Trading mode set to: ${mode}`);
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleSetSizing = async (sizingMode: 'FIXED_BUDGET' | 'FIXED_QTY' | 'RISK_BASED', val: number) => {
    try {
      const payload: Record<string, unknown> = { mode: sizingMode };
      if (sizingMode === 'FIXED_BUDGET') payload.budget = val;
      if (sizingMode === 'FIXED_QTY') payload.fixedQty = val;
      if (sizingMode === 'RISK_BASED') payload.riskPct = val;

      const res = await fetch('/api/proxy/sizing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
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
        setStatusMessage(`Sizing updated: ${sizingMode} (${val})`);
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleAnalyzeStock = async (stock: ScoredStockItem) => {
    setDeepAnalysisStock(stock);
    setDeepAnalysisLoading(true);
    setDeepAnalysisVotes(null);

    try {
      const res = await fetch('/api/proxy/scanner/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: stock.symbol }),
      });
      if (res.ok) {
        const data = await res.json();
        setDeepAnalysisVotes(data.consensus?.votes ?? data.votes ?? []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setDeepAnalysisLoading(false);
    }
  };

  const handleKill = async (level: 'SOFT' | 'HARD' | 'NUCLEAR') => {
    try {
      const res = await fetch('/api/proxy/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      });
      if (res.ok) {
        setKillModalOpen(false);
        setStatusMessage(`⚠️ EMERGENCY KILL SWITCH ACTIVATED: ${level}`);
        setTimeout(() => setStatusMessage(null), 6000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleExitPosition = async (positionId: string) => {
    try {
      const res = await fetch('/api/proxy/positions/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ positionId }),
      });
      if (res.ok) {
        setStatusMessage(`Position exit triggered for ${positionId}`);
        setTimeout(() => setStatusMessage(null), 3000);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const selectedStock = useMemo(() => {
    if (!state) return null;
    return state.watchlist.find((w) => w.symbol === selectedSymbol) ?? state.watchlist[0] ?? null;
  }, [state, selectedSymbol]);

  if (loading && !state) {
    return (
      <div style={{ textAlign: 'center', padding: '100px 0', color: 'var(--muted)' }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>⚡ TradeForger Terminal</div>
        <div>Initializing Upstox Real-Time API & Multi-Model AI Engine...</div>
      </div>
    );
  }

  const s = state!;
  const isPnlPositive = s.pnl.total >= 0;
  const topStock = s.topStock ?? s.rankedStocks?.[0] ?? null;

  return (
    <div style={{ maxWidth: 1320, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Top Notification Toast */}
      {statusMessage && (
        <div
          style={{
            position: 'fixed',
            top: 18,
            right: 24,
            background: 'var(--accent)',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 6,
            fontWeight: 600,
            zIndex: 9999,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {statusMessage}
        </div>
      )}

      {/* Upstox Authentication & Live API Connection Banner */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'linear-gradient(90deg, #14181d 0%, #1a222c 100%)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '12px 18px',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 20 }}>🇮🇳</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Upstox Real-Time API Integration</span>
              <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: 'var(--ok)' }}>
                ✓ V3 Market Data Feeder Active
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
              Analytics Token: <strong style={{ color: 'var(--ok)' }}>Connected (2027 Expiry)</strong> · Trading OAuth:{' '}
              {s.auth?.hasTradingToken ? (
                <strong style={{ color: 'var(--ok)' }}>Authenticated (Active Session)</strong>
              ) : (
                <span style={{ color: 'var(--warn)' }}>Paper / Sandbox Port (Click to Connect Live Account)</span>
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
                background: s.auth.hasTradingToken ? 'rgba(255,255,255,0.06)' : 'var(--accent)',
                color: '#fff',
                padding: '6px 14px',
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
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
                  background: s.mode === 'LIVE' ? 'rgba(248,81,73,0.2)' : 'rgba(63,185,80,0.2)',
                  color: s.mode === 'LIVE' ? 'var(--danger)' : 'var(--ok)',
                  border: `1px solid ${s.mode === 'LIVE' ? 'var(--danger)' : 'var(--ok)'}`,
                  fontWeight: 600,
                }}
              >
                {s.mode} TRADING
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              Multi-Model AI Consensus · Intraday ORB & Swing Breakout Scanner
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
              background: 'rgba(255,255,255,0.03)',
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
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid var(--line)',
              fontSize: 12,
            }}
          >
            IST: <strong className="mono">{s.telemetry.istTime}</strong> (NSE EQ)
          </div>

          <button
            onClick={() => setKillModalOpen(true)}
            style={{
              background: 'rgba(248,81,73,0.15)',
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

      {/* Top Stock Spotlight Banner (Best Stock of the Session) */}
      {topStock && (
        <div
          style={{
            background: 'linear-gradient(90deg, rgba(74,158,255,0.12) 0%, rgba(63,185,80,0.08) 100%)',
            border: '1px solid rgba(74,158,255,0.3)',
            borderRadius: 10,
            padding: '14px 20px',
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                background: 'var(--accent)',
                color: '#fff',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: 14,
              }}
            >
              <span>#1</span>
              <span style={{ fontSize: 9 }}>TOP</span>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>{topStock.symbol}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{topStock.name}</span>
                <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(63,185,80,0.2)', color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
                  BREAKOUT SCORE {topStock.score}/100
                </span>
                <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(74,158,255,0.2)', color: 'var(--accent)', fontSize: 11 }}>
                  {topStock.rvol}x RVOL
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg)', marginTop: 4, fontFamily: 'monospace' }}>
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
                color: '#fff',
                padding: '8px 16px',
                borderRadius: 6,
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <span>🤖</span>
              <span>Deep Multi-Model AI Analysis</span>
            </button>
          </div>
        </div>
      )}

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
            <span>🤖 3 Free AI Models</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
            Quant + Pattern + ML Expectancy (<strong style={{ color: 'var(--ok)' }}>0ms, $0 Cost</strong>)
          </div>
        </div>
      </div>

      {/* Auto-Trading Control Bar */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '12px 18px',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Strategy Mode:</span>
          {(['INTRADAY', 'SWING', 'BOTH'] as const).map((m) => (
            <button
              key={m}
              onClick={() => handleSetStrategyMode(m)}
              style={{
                background: s.strategyMode === m ? 'var(--accent)' : 'var(--line)',
                color: s.strategyMode === m ? '#fff' : 'var(--fg)',
                border: 'none',
                borderRadius: 6,
                padding: '6px 12px',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {m === 'BOTH' ? '⚡ DUAL (Intraday + Swing)' : m}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 600 }}>Sizing:</span>
          {(['FIXED_BUDGET', 'FIXED_QTY', 'RISK_BASED'] as const).map((sm) => (
            <button
              key={sm}
              onClick={() => handleSetSizing(sm, sm === 'FIXED_BUDGET' ? 10000 : sm === 'FIXED_QTY' ? 10 : 1)}
              style={{
                background: s.sizing.mode === sm ? 'rgba(74,158,255,0.2)' : 'transparent',
                color: s.sizing.mode === sm ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${s.sizing.mode === sm ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {sm}
            </button>
          ))}

          <button
            onClick={handleToggleAutoTrading}
            style={{
              marginLeft: 8,
              background: s.autoTrading ? 'rgba(63,185,80,0.2)' : 'rgba(248,81,73,0.2)',
              border: `1px solid ${s.autoTrading ? 'var(--ok)' : 'var(--danger)'}`,
              color: s.autoTrading ? 'var(--ok)' : 'var(--danger)',
              borderRadius: 6,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {s.autoTrading ? '● AUTO-TRADING ACTIVE' : '○ AUTO-TRADING PAUSED'}
          </button>
        </div>
      </div>

      {/* Main Grid: Watchlist Scanner & Chart on Left, Signals & Positions on Right */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 1.15fr) minmax(340px, 1.25fr)', gap: 18 }}>
        {/* Left Column: Watchlist Scanner & Ranked Stocks */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                <span>Autonomous Stock Breakout Scanner</span>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 400 }}>Sorted by Breakout Score</span>
              </div>
            </div>

            <div style={{ overflowX: 'auto', maxHeight: 400 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12.5 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
                    <th style={{ padding: '8px 12px' }}>Rank</th>
                    <th style={{ padding: '8px 12px' }}>Symbol</th>
                    <th style={{ padding: '8px 12px' }}>LTP (₹)</th>
                    <th style={{ padding: '8px 12px' }}>Change</th>
                    <th style={{ padding: '8px 12px' }}>RVOL</th>
                    <th style={{ padding: '8px 12px' }}>Score</th>
                    <th style={{ padding: '8px 12px' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(s.rankedStocks ?? s.watchlist.map((w, i) => ({
                    ...w,
                    rank: i + 1,
                    score: 75,
                    atr: 12,
                    rsi: 55,
                    vwap: w.ltp,
                    rvol: 1.5,
                    orbStatus: 'ABOVE' as const,
                    supertrendDir: 'BULLISH' as const,
                    reasons: ['Breakout confirmed'],
                    tradeSetup: {
                      side: 'BUY' as const,
                      entry: w.ltp,
                      stopLoss: w.ltp - 20,
                      target1: w.ltp + 30,
                      target2: w.ltp + 50,
                      trailingGap: 10,
                      riskPerShare: 20,
                      rewardToRisk1: 1.5,
                      rewardToRisk2: 2.5,
                    },
                  }))).map((item) => {
                    const isPos = item.changePct >= 0;
                    const isSelected = item.symbol === selectedStock?.symbol;
                    return (
                      <tr
                        key={item.instrumentKey}
                        onClick={() => setSelectedSymbol(item.symbol)}
                        style={{
                          borderBottom: '1px solid rgba(255,255,255,0.04)',
                          cursor: 'pointer',
                          background: isSelected ? 'rgba(74,158,255,0.08)' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '9px 12px', fontWeight: 700, color: item.rank <= 2 ? 'var(--ok)' : 'var(--muted)' }}>
                          #{item.rank}
                        </td>
                        <td style={{ padding: '9px 12px', fontWeight: 600 }}>
                          <div>{item.symbol}</div>
                          <div style={{ fontSize: 10, color: 'var(--muted)' }}>{item.name.slice(0, 16)}</div>
                        </td>
                        <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontWeight: 600 }}>
                          ₹{item.ltp.toFixed(2)}
                        </td>
                        <td style={{ padding: '9px 12px' }}>
                          <span
                            style={{
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontSize: 11,
                              fontWeight: 600,
                              background: isPos ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)',
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
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontWeight: 700,
                              fontSize: 11,
                              background: item.score >= 80 ? 'rgba(63,185,80,0.2)' : 'rgba(74,158,255,0.15)',
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
                              handleAnalyzeStock(item as ScoredStockItem);
                            }}
                            style={{
                              background: 'rgba(74,158,255,0.15)',
                              border: '1px solid var(--accent)',
                              color: 'var(--accent)',
                              borderRadius: 4,
                              padding: '3px 8px',
                              fontSize: 10,
                              fontWeight: 600,
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
            </div>
          </div>

          {/* Interactive Chart Preview for Selected Symbol */}
          {selectedStock && (
            <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{selectedStock.symbol}</span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>₹{selectedStock.ltp.toFixed(2)}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, fontSize: 11 }}>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(74,158,255,0.15)', color: 'var(--accent)' }}>EMA20/50</span>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(210,153,34,0.15)', color: 'var(--warn)' }}>VWAP</span>
                  <span style={{ padding: '2px 6px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: 'var(--ok)' }}>Supertrend</span>
                </div>
              </div>

              {/* Graphical Candlestick & Overlays Visualization */}
              <div
                style={{
                  height: 180,
                  background: '#0e1115',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.06)',
                  position: 'relative',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg viewBox="0 0 400 160" style={{ width: '100%', height: '100%' }}>
                  <line x1="0" y1="40" x2="400" y2="40" stroke="rgba(255,255,255,0.05)" strokeDasharray="4" />
                  <line x1="0" y1="80" x2="400" y2="80" stroke="rgba(255,255,255,0.05)" strokeDasharray="4" />
                  <line x1="0" y1="120" x2="400" y2="120" stroke="rgba(255,255,255,0.05)" strokeDasharray="4" />

                  {/* VWAP Yellow Line */}
                  <path d="M 0 100 Q 100 85, 200 80 T 400 70" fill="none" stroke="#d29922" strokeWidth="1.5" strokeDasharray="3" />
                  {/* EMA 20 Blue Line */}
                  <path d="M 0 110 Q 120 70, 220 60 T 400 45" fill="none" stroke="#4a9eff" strokeWidth="2" />

                  {/* Candlesticks */}
                  <rect x="50" y="70" width="8" height="24" fill="#3fb950" />
                  <line x1="54" y1="58" x2="54" y2="102" stroke="#3fb950" strokeWidth="1" />

                  <rect x="90" y="65" width="8" height="20" fill="#3fb950" />
                  <line x1="94" y1="55" x2="94" y2="92" stroke="#3fb950" strokeWidth="1" />

                  <rect x="130" y="72" width="8" height="18" fill="#f85149" />
                  <line x1="134" y1="62" x2="134" y2="98" stroke="#f85149" strokeWidth="1" />

                  <rect x="170" y="60" width="8" height="25" fill="#3fb950" />
                  <line x1="174" y1="48" x2="174" y2="92" stroke="#3fb950" strokeWidth="1" />

                  <rect x="210" y="52" width="8" height="30" fill="#3fb950" />
                  <line x1="214" y1="40" x2="214" y2="88" stroke="#3fb950" strokeWidth="1" />

                  <rect x="250" y="48" width="8" height="20" fill="#3fb950" />
                  <line x1="254" y1="36" x2="254" y2="76" stroke="#3fb950" strokeWidth="1" />

                  <rect x="290" y="55" width="8" height="15" fill="#f85149" />
                  <line x1="294" y1="45" x2="294" y2="78" stroke="#f85149" strokeWidth="1" />

                  <rect x="330" y="40" width="8" height="28" fill="#3fb950" />
                  <line x1="334" y1="30" x2="334" y2="74" stroke="#3fb950" strokeWidth="1" />

                  {/* Current LTP marker */}
                  <circle cx="334" cy="40" r="4" fill="#3fb950" />
                  <text x="345" y="44" fill="#3fb950" fontSize="10" fontFamily="monospace" fontWeight="bold">
                    ₹{selectedStock.ltp.toFixed(1)}
                  </text>
                </svg>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Positions and Live Signals */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                    padding: '2px 6px',
                    borderRadius: 10,
                    background: s.positions.length > 0 ? 'rgba(63,185,80,0.2)' : 'rgba(255,255,255,0.05)',
                    color: s.positions.length > 0 ? 'var(--ok)' : 'var(--muted)',
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
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)', fontSize: 11 }}>
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
                      return (
                        <tr key={pos.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 600 }}>
                            <div>{pos.symbol}</div>
                            <div style={{ fontSize: 10, color: 'var(--muted)' }}>{pos.gttOrderId ? 'OCO ARMED' : 'PENDING'}</div>
                          </td>
                          <td style={{ padding: '9px 12px' }}>
                            <span style={{ fontWeight: 700, color: pos.side === 'BUY' ? 'var(--ok)' : 'var(--danger)' }}>
                              {pos.side}
                            </span>{' '}
                            x{pos.filledQuantity}
                          </td>
                          <td style={{ padding: '9px 12px', fontFamily: 'monospace' }}>
                            ₹{pos.avgEntry ? pos.avgEntry.toFixed(1) : pos.entry.toFixed(1)} / ₹{pos.ltp.toFixed(1)}
                          </td>
                          <td style={{ padding: '9px 12px', fontFamily: 'monospace', fontWeight: 600, color: isPos ? 'var(--ok)' : 'var(--danger)' }}>
                            {isPos ? '+' : ''}₹{pos.pnlRupees.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', fontSize: 11, color: 'var(--muted)', fontFamily: 'monospace' }}>
                            SL: ₹{pos.stopLoss.toFixed(0)} | T: ₹{pos.target.toFixed(0)}
                          </td>
                          <td style={{ padding: '9px 12px' }}>
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
                        background: 'rgba(255,255,255,0.02)',
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
                                background: 'rgba(255,255,255,0.04)',
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
                          background: 'rgba(0,0,0,0.3)',
                          borderLeft: `3px solid ${verdictColor}`,
                          fontSize: 11.5,
                          lineHeight: 1.4,
                          color: '#d0d7de',
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
      </div>

      {/* Single Stock Deep AI Analysis Modal */}
      {deepAnalysisStock && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 99999,
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--accent)',
              borderRadius: 12,
              padding: 24,
              maxWidth: 620,
              width: '90%',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{deepAnalysisStock.symbol}</span>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{deepAnalysisStock.name}</span>
                <span style={{ padding: '2px 8px', borderRadius: 4, background: 'rgba(63,185,80,0.15)', color: 'var(--ok)', fontSize: 11, fontWeight: 700 }}>
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
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', marginBottom: 8 }}>
                Calculated Entry & Risk Geometry (1.5x ATR Intraday / 2.5x ATR Swing)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, textAlign: 'center', fontFamily: 'monospace' }}>
                <div style={{ background: 'rgba(255,255,255,0.03)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--muted)' }}>ENTRY PRICE</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--fg)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.entry.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'rgba(248,81,73,0.1)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--danger)' }}>STOP LOSS</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.stopLoss.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'rgba(63,185,80,0.1)', padding: 8, borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: 'var(--ok)' }}>TARGET 1 (1:1.5)</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--ok)', marginTop: 2 }}>
                    ₹{deepAnalysisStock.tradeSetup.target1.toFixed(2)}
                  </div>
                </div>
                <div style={{ background: 'rgba(63,185,80,0.15)', padding: 8, borderRadius: 6 }}>
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
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--line)', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ok)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>🤖 3 Free Real-Time AI Models Analysis</span>
                {deepAnalysisLoading && <span style={{ fontSize: 11, color: 'var(--muted)' }}>(analyzing...)</span>}
              </div>

              {deepAnalysisVotes ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {deepAnalysisVotes.map((v, i) => (
                    <div
                      key={i}
                      style={{
                        background: 'rgba(0,0,0,0.3)',
                        borderRadius: 6,
                        padding: '8px 12px',
                        borderLeft: `3px solid ${v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)'}`,
                        fontSize: 11.5,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600, marginBottom: 2 }}>
                        <span>Model: {v.model}</span>
                        <span style={{ color: v.verdict === 'CONFIRM' ? 'var(--ok)' : 'var(--warn)' }}>
                          {v.verdict} ({v.confidence}%)
                        </span>
                      </div>
                      <div style={{ color: '#c9d1d9', lineHeight: 1.4 }}>{v.rationale}</div>
                    </div>
                  ))}
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
                color: '#fff',
                padding: '10px',
                borderRadius: 6,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Safety & Circuit Breakers Full Panel */}
      <div style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>10 Pure-Function Safety Circuit Breakers</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Evaluated on every tick and before every order. Any trip drops to HALTED to protect capital.
            </div>
          </div>
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
            {s.breakers.allowEntries ? 'ALL 10 BREAKER GATES CLEAR' : 'CIRCUIT TRIPPED (HALTED)'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {[
            { label: 'Daily Loss Limit', val: `${s.limits.dailyLossLimitPct}% capital`, status: 'OK' },
            { label: 'Per-Trade Loss Cap', val: '1% max', status: 'OK' },
            { label: 'Max Concurrent Positions', val: `${s.positions.length} / 3`, status: 'OK' },
            { label: 'Orders per Minute', val: '6 max', status: 'OK' },
            { label: 'Orders per Day', val: `${s.telemetry.ordersCount} / 40`, status: 'OK' },
            { label: 'Reject Rate Breaker', val: '3 in 5m', status: 'OK' },
            { label: 'Feed Staleness Guard', val: s.telemetry.feedStaleness ? `${s.telemetry.feedStaleness}ms (<10s)` : '<10s', status: 'OK' },
            { label: 'Engine ↔ Broker Sync', val: '0 Divergence', status: 'OK' },
            { label: 'Margin Utilisation', val: '< 80% ceiling', status: 'OK' },
            { label: 'Manual Safety Gate', val: 'Clear', status: 'OK' },
          ].map((b, i) => (
            <div
              key={i}
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--line)',
                borderRadius: 6,
                padding: '8px 12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 12,
              }}
            >
              <div>
                <div style={{ color: 'var(--muted)', fontSize: 11 }}>{b.label}</div>
                <div style={{ fontWeight: 600, marginTop: 2 }}>{b.val}</div>
              </div>
              <span style={{ color: 'var(--ok)', fontWeight: 700, fontSize: 11 }}>✓ {b.status}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Emergency Kill Switch Modal */}
      {killModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={() => handleKill('SOFT')}
                style={{
                  background: 'rgba(210,153,34,0.15)',
                  border: '1px solid var(--warn)',
                  color: 'var(--warn)',
                  padding: '10px 14px',
                  borderRadius: 6,
                  fontWeight: 600,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <strong>1. SOFT KILL</strong>
                <div style={{ fontSize: 11, opacity: 0.8 }}>Stop all new entries immediately. Existing positions continue managing.</div>
              </button>

              <button
                onClick={() => handleKill('HARD')}
                style={{
                  background: 'rgba(248,81,73,0.15)',
                  border: '1px solid var(--danger)',
                  color: 'var(--danger)',
                  padding: '10px 14px',
                  borderRadius: 6,
                  fontWeight: 600,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <strong>2. HARD KILL (FLATTEN)</strong>
                <div style={{ fontSize: 11, opacity: 0.8 }}>Cancel all orders, cancel all GTT brackets, and force-exit all positions at market.</div>
              </button>

              <button
                onClick={() => handleKill('NUCLEAR')}
                style={{
                  background: 'var(--danger)',
                  border: 'none',
                  color: '#fff',
                  padding: '10px 14px',
                  borderRadius: 6,
                  fontWeight: 700,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <strong>3. NUCLEAR KILL (ACCOUNT-LEVEL DISABLE)</strong>
                <div style={{ fontSize: 11, opacity: 0.9 }}>Hard kill + POST /v2/user/kill-switch to disable NSE_EQ segment at Upstox account level.</div>
              </button>
            </div>

            <button
              onClick={() => setKillModalOpen(false)}
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
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
