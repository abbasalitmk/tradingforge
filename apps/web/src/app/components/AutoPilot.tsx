'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Panel, Chip, Pill, Stat, Note, inputStyle, buttonStyle, api, rupees, num, sideColor, qualityColor, useNarrow, type Side } from './ui.tsx';
import StrategyLab from './StrategyLab.tsx';

interface AutoConfig {
  enabled: boolean;
  targetMode: 'ALL_SCANNED' | 'SINGLE_STOCK';
  targetSymbol: string;
  minPrice: number;
  maxPrice: number;
  segments: { intraday: boolean; swing: boolean; fno: boolean };
  minQuality: number;
  minRewardRisk: number;
  minNetRewardRisk: number;
  confirmSeconds: number;
  strategies: string[];
  maxEntriesPerDay: number;
  maxOpenPositions: number;
  maxPerStrategy: number;
  maxSameSide: number;
  trailStop: boolean;
  pauseLosingStrategies: boolean;
  skipFailedStrategies: boolean;
  tradeSide: 'BUY' | 'SELL' | 'BOTH';
  autoUniverse: boolean;
  autoUniverseSize: number;
  autoUniverseMinTurnoverCr: number;
  maxEntriesMorning: number;
  maxEntriesAfternoon: number;
  maxPerSector: number;
  reentryCooldownMin: number;
  closedBarEntries: boolean;
  htfBias: boolean;
  htfBiasStrict: boolean;
  maxLeverage: number;
  maxVwapStretchAtr: number;
  maxSetupAgeMin: number;
}

interface AutoUniverseView {
  enabled: boolean;
  picks: string[];
  refreshedAt: number | null;
  scanned: number;
  error: string | null;
}

interface LiveSetupView {
  instrumentKey: string;
  symbol: string;
  style: 'INTRADAY' | 'SWING';
  side: Side;
  entry: number;
  stopLoss: number;
  target: number;
  rewardRisk: number;
  quality: number;
  primaryStrategyId: string;
  agreeing: string[];
  conflicting: string[];
  reasons: string[];
  stableSeconds: number;
  partialBar: boolean;
  route: 'EQ_INTRADAY' | 'EQ_SWING' | 'FNO' | null;
  eligible: boolean;
  blockers: string[];
}

interface AutoLogEntry {
  at: number;
  symbol: string;
  style: string;
  side: Side;
  route: string;
  quality: number;
  strategyId: string;
  outcome: 'PLACED' | 'REJECTED' | 'AI_BLOCKED';
  detail: string;
}

interface LiveAnalysisResponse {
  intervalMs: number;
  mode: string;
  auto: AutoConfig;
  entriesToday: number;
  entriesBySession?: { MORNING: number; AFTERNOON: number };
  account?: {
    riskCapital: number; fromBroker: boolean; available: number | null;
    marginUtilisationPct: number; maxExposure: number; deployed: number;
  };
  setups: LiveSetupView[];
  analyzed: number;
  autoUniverse?: AutoUniverseView;
  autoLog: AutoLogEntry[];
  priceSource?: 'WEBSOCKET' | 'REST_POLL' | 'NONE';
  feedIssue?: string | null;
  breakers?: Array<{ id: string; detail: string }>;
  fno?: {
    deskEnabled: boolean;
    instrument: 'OPTIONS' | 'FUTURES';
    maxLots: number;
    underlyings: Array<{ symbol: string; expiry: string | null; lotSize: number | null; error: string | null; spot: number | null }>;
  };
  strategies: Array<{
    id: string; name: string; style: 'INTRADAY' | 'SWING'; approved: string | null;
    record: { trades: number; expectancyR: number } | null;
    verdict: { status: 'APPROVED' | 'VALIDATED' | 'REJECTED'; oosExpectancyR: number | null } | null;
  }>;
}

interface WatchlistResponse {
  max: number;
  default: string[];
  added: Array<{ symbol: string; name: string; instrumentKey: string; bars: number }>;
  autoUniverse?: AutoUniverseView;
}

type Draft = Pick<AutoConfig,
  | 'minQuality' | 'minRewardRisk' | 'minNetRewardRisk' | 'confirmSeconds' | 'maxEntriesPerDay' | 'strategies'
  | 'maxOpenPositions' | 'maxPerStrategy' | 'maxSameSide' | 'trailStop' | 'pauseLosingStrategies' | 'skipFailedStrategies'
  | 'autoUniverse' | 'autoUniverseSize' | 'autoUniverseMinTurnoverCr'
  | 'maxEntriesMorning' | 'maxEntriesAfternoon' | 'maxPerSector' | 'reentryCooldownMin' | 'closedBarEntries' | 'htfBias' | 'htfBiasStrict' | 'maxLeverage' | 'maxVwapStretchAtr' | 'maxSetupAgeMin'>;

const draftOf = (a: AutoConfig): Draft => ({
  minQuality: a.minQuality, minRewardRisk: a.minRewardRisk, minNetRewardRisk: a.minNetRewardRisk, confirmSeconds: a.confirmSeconds,
  maxEntriesPerDay: a.maxEntriesPerDay, strategies: [...a.strategies],
  maxOpenPositions: a.maxOpenPositions, maxPerStrategy: a.maxPerStrategy, maxSameSide: a.maxSameSide,
  trailStop: a.trailStop, pauseLosingStrategies: a.pauseLosingStrategies, skipFailedStrategies: a.skipFailedStrategies,
  autoUniverse: a.autoUniverse,
  autoUniverseSize: a.autoUniverseSize, autoUniverseMinTurnoverCr: a.autoUniverseMinTurnoverCr,
  maxEntriesMorning: a.maxEntriesMorning, maxEntriesAfternoon: a.maxEntriesAfternoon,
  maxPerSector: a.maxPerSector, reentryCooldownMin: a.reentryCooldownMin,
  closedBarEntries: a.closedBarEntries, htfBias: a.htfBias, htfBiasStrict: a.htfBiasStrict,
  maxLeverage: a.maxLeverage, maxVwapStretchAtr: a.maxVwapStretchAtr, maxSetupAgeMin: a.maxSetupAgeMin,
});
const sameDraft = (x: Draft, y: Draft): boolean => JSON.stringify(x) === JSON.stringify(y);

const ROUTE_LABEL: Record<string, string> = { EQ_INTRADAY: 'Cash · Intraday', EQ_SWING: 'Cash · Swing', FNO: 'F&O' };
const OUTCOME_COLOR: Record<AutoLogEntry['outcome'], string> = { PLACED: 'var(--ok)', REJECTED: 'var(--warn)', AI_BLOCKED: 'var(--danger)' };

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, verticalAlign: 'top' };

/**
 * What autonomous mode is actually doing: the rules it applies, every setup it
 * is watching with the exact reasons it is or is not trading each one, its
 * recent decisions, and the set of stocks it watches.
 */
export default function AutoPilot({ onToast }: { onToast: (msg: string, kind?: 'ok' | 'error') => void }) {
  const [live, setLive] = useState<LiveAnalysisResponse | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [watch, setWatch] = useState<WatchlistResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [addSymbol, setAddSymbol] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [fnoBusy, setFnoBusy] = useState(false);
  const narrow = useNarrow();
  const serverDraft = useRef<Draft | null>(null);

  const loadLive = useCallback(async () => {
    const r = await api<LiveAnalysisResponse>('/api/proxy/analysis/live');
    if (!r.ok) { setLiveError(r.error); return; }
    setLiveError(null);
    setLive(r.data);
    const fresh = draftOf(r.data.auto);
    // Follow the engine until the user starts editing; never clobber an unsaved edit.
    setDraft((d) => (d === null || (serverDraft.current && sameDraft(d, serverDraft.current)) ? fresh : d));
    serverDraft.current = fresh;
  }, []);

  const loadWatch = useCallback(async () => {
    const r = await api<WatchlistResponse>('/api/proxy/watchlist');
    if (r.ok) setWatch(r.data);
  }, []);

  useEffect(() => {
    void loadLive();
    void loadWatch();
    const a = setInterval(() => void loadLive(), 2_000);
    const b = setInterval(() => void loadWatch(), 15_000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [loadLive, loadWatch]);

  const dirty = draft !== null && serverDraft.current !== null && !sameDraft(draft, serverDraft.current);

  /** One switch for autonomous F&O: loads the desk if needed and allows or stops F&O entries. */
  const setFnoAuto = async (on: boolean) => {
    if (on && !window.confirm(
      'Turn ON automated F&O trading?\n\n'
      + '• Setups on F&O underlyings route to index options (or futures, per TF_FNO_INSTRUMENT).\n'
      + '• An option can lose its entire premium; size is capped per trade and by the max-lots limit.\n'
      + '• Every entry still has to pass the same rules (validated strategy, R:R, limits, AI review).',
    )) return;
    setFnoBusy(true);
    const r = await api<{ fnoAuto: boolean; deskEnabled: boolean }>('/api/proxy/auto/fno', { enabled: on });
    setFnoBusy(false);
    if (!r.ok) return onToast(`F&O auto-trading NOT changed: ${r.error}`, 'error');
    onToast(r.data.fnoAuto ? '📈 F&O auto-trading ON' : 'F&O auto-trading OFF');
    void loadLive();
  };

  const save = async () => {
    if (!draft || !live) return;
    setSaving(true);
    const r = await api<AutoConfig>('/api/proxy/auto/config', {
      minQuality: draft.minQuality,
      minRewardRisk: draft.minRewardRisk,
      minNetRewardRisk: draft.minNetRewardRisk,
      confirmSeconds: draft.confirmSeconds,
      maxEntriesPerDay: draft.maxEntriesPerDay,
      strategies: draft.strategies,
      maxOpenPositions: draft.maxOpenPositions,
      maxPerStrategy: draft.maxPerStrategy,
      maxSameSide: draft.maxSameSide,
      trailStop: draft.trailStop,
      pauseLosingStrategies: draft.pauseLosingStrategies,
      skipFailedStrategies: draft.skipFailedStrategies,
      autoUniverse: draft.autoUniverse,
      autoUniverseSize: draft.autoUniverseSize,
      autoUniverseMinTurnoverCr: draft.autoUniverseMinTurnoverCr,
      maxEntriesMorning: draft.maxEntriesMorning,
      maxEntriesAfternoon: draft.maxEntriesAfternoon,
      maxPerSector: draft.maxPerSector,
      reentryCooldownMin: draft.reentryCooldownMin,
      closedBarEntries: draft.closedBarEntries,
      htfBias: draft.htfBias,
      htfBiasStrict: draft.htfBiasStrict,
      maxLeverage: draft.maxLeverage,
      maxVwapStretchAtr: draft.maxVwapStretchAtr,
      maxSetupAgeMin: draft.maxSetupAgeMin,
    });
    setSaving(false);
    if (!r.ok) return onToast(`Autopilot rules NOT saved: ${r.error}`, 'error');
    serverDraft.current = draftOf(r.data);
    setDraft(draftOf(r.data));
    onToast('✓ Autopilot rules saved — applied from the next analysis cycle');
  };

  const addToWatch = async () => {
    const symbols = addSymbol.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    if (symbols.length === 0) return;
    const r = await api<{ added: string[]; failed: Array<{ symbol: string; error: string }> }>('/api/proxy/watchlist/add', { symbols });
    if (!r.ok) return onToast(`Watchlist: ${r.error}`, 'error');
    setAddSymbol('');
    void loadWatch();
    const failed = r.data.failed.map((f) => `${f.symbol} (${f.error})`).join(', ');
    onToast(`Watching ${r.data.added.join(', ')} live${failed ? ` — not added: ${failed}` : ''}`, failed ? 'error' : 'ok');
  };

  const removeFromWatch = async (symbol: string) => {
    const r = await api('/api/proxy/watchlist/remove', { symbol });
    if (!r.ok) return onToast(`Could not remove ${symbol}: ${r.error}`, 'error');
    void loadWatch();
  };

  if (!live || !draft) {
    return (
      <Panel title="Autopilot" subtitle="Live analysis and autonomous entry rules">
        <Note kind={liveError ? 'danger' : 'muted'}>{liveError ? `Engine analysis unavailable: ${liveError}` : 'Loading live analysis…'}</Note>
      </Panel>
    );
  }

  const a = live.auto;
  const eligible = live.setups.filter((s) => s.eligible);
  const liveApproved = live.strategies.filter((st) => st.approved).map((st) => st.name);
  const shown = showAll ? live.setups : live.setups.slice(0, 12);
  const toggleStrategy = (id: string) => setDraft((d) => d && ({
    ...d, strategies: d.strategies.includes(id) ? d.strategies.filter((x) => x !== id) : [...d.strategies, id],
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel
        title="Autopilot status"
        subtitle={`Every ${Math.round(live.intervalMs / 1000)}s the engine re-analyses ${live.analyzed} instruments with every enabled strategy and acts on at most one eligible setup per cycle.`}
        right={<Pill color={a.enabled ? 'var(--ok)' : 'var(--muted)'}>{a.enabled ? '● AUTO ON' : '○ AUTO OFF'}</Pill>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 6 }}>
          <Stat label="Mode" value={live.mode} color={live.mode === 'LIVE' ? 'var(--danger)' : undefined} />
          <Stat label="Scope" value={a.targetMode === 'SINGLE_STOCK' ? a.targetSymbol : 'All watched'} />
          <Stat label="Eligible now" value={eligible.length} color={eligible.length ? 'var(--ok)' : undefined} />
          <Stat label="Entries today" value={`${live.entriesToday} / ${a.maxEntriesPerDay}`} />
          <Stat
            label="AM · PM entries"
            value={`${live.entriesBySession?.MORNING ?? 0}/${a.maxEntriesMorning} · ${live.entriesBySession?.AFTERNOON ?? 0}/${a.maxEntriesAfternoon}`}
          />
          {live.account && (
            <Stat
              label={live.account.fromBroker ? 'Capital (Upstox)' : 'Capital (configured)'}
              value={`₹${live.account.riskCapital.toLocaleString('en-IN')} · ₹${live.account.deployed.toLocaleString('en-IN')} / ₹${live.account.maxExposure.toLocaleString('en-IN')}`}
            />
          )}
          {live.account?.fromBroker && (
            <Stat
              label="Margin used"
              value={`${live.account.marginUtilisationPct}%`}
              color={live.account.marginUtilisationPct >= 80 ? 'var(--danger)' : live.account.marginUtilisationPct >= 60 ? 'var(--warn)' : undefined}
            />
          )}
          <Stat label="Direction" value={a.tradeSide === 'BUY' ? 'Buy only' : a.tradeSide === 'SELL' ? 'Short only' : 'Buy + Short'} />
          <Stat label="Segments" value={[a.segments.intraday && 'Intraday', a.segments.swing && 'Swing', a.segments.fno && 'F&O'].filter(Boolean).join(' + ') || 'none'} />
          <Stat
            label="Prices"
            value={live.priceSource === 'WEBSOCKET' ? 'Live ticks' : live.priceSource === 'REST_POLL' ? 'REST · 2s' : 'NO PRICES'}
            color={live.priceSource === 'WEBSOCKET' ? 'var(--ok)' : live.priceSource === 'REST_POLL' ? 'var(--warn)' : 'var(--danger)'}
          />
        </div>
        {live.breakers && live.breakers.length > 0 && (
          <Note kind="danger">Entries blocked by circuit breaker: {live.breakers.map((b) => `${b.id} (${b.detail})`).join(' · ')}</Note>
        )}
        {live.feedIssue && <Note kind="warn">Market feed: {live.feedIssue}. Prices come from REST polling every 2 s, so entries and exits react slower than tick data.</Note>}
        {!a.enabled && <Note>Autonomous entries are off — the table below shows what it <em>would</em> do. Turn it on from the command hub.</Note>}
        {live.mode === 'LIVE' && (
          <Note kind={liveApproved.length < 3 ? 'warn' : 'muted'}>
            In LIVE only strategies with an APPROVED version can lead an entry: {liveApproved.length ? liveApproved.join(', ') : 'none'}.
            {liveApproved.length < 3 ? ' Validate and approve more in the Strategy Lab below to trade more setups.' : ''}
          </Note>
        )}
      </Panel>

      <Panel
        title="F&O auto-trading"
        subtitle="Index setups become option (or futures) trades: strike by delta, premium stop, time stop against theta."
        right={
          <button
            type="button" disabled={fnoBusy} onClick={() => void setFnoAuto(!a.segments.fno)}
            aria-pressed={a.segments.fno}
            style={{
              ...buttonStyle, padding: '6px 14px', opacity: fnoBusy ? 0.6 : 1,
              background: a.segments.fno ? 'var(--ok)' : 'var(--panel-subtle)',
              color: a.segments.fno ? '#ffffff' : 'var(--fg)',
              border: `1px solid ${a.segments.fno ? 'var(--ok)' : 'var(--line)'}`, boxShadow: 'none',
            }}
          >
            {fnoBusy ? '…' : a.segments.fno ? '● F&O ON — turn off' : '○ F&O OFF — turn on'}
          </button>
        }
      >
        {live.fno && live.fno.deskEnabled ? (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {live.fno.underlyings.map((u) => (
                <span key={u.symbol} style={{ fontSize: 11.5, padding: '4px 9px', borderRadius: 8, border: `1px solid ${u.error ? 'var(--danger)' : 'var(--line)'}`, background: 'var(--panel-subtle)' }}>
                  <strong>{u.symbol}</strong>{u.spot !== null ? ` ${num(u.spot)}` : ''}
                  <span style={{ color: u.error ? 'var(--danger)' : 'var(--muted)' }}> · {u.error ?? `exp ${u.expiry ?? '—'} · lot ${u.lotSize ?? '—'}`}</span>
                </span>
              ))}
            </div>
            <Note>{live.fno.instrument === 'FUTURES' ? 'Futures' : 'Long options (buy calls / puts)'} · max {live.fno.maxLots} lot(s) per trade{a.segments.fno ? '' : ' · desk loaded for analysis, entries off'}</Note>
          </>
        ) : (
          <Note>F&O desk not loaded. Turning F&O on loads the contract master and option chains (a few seconds).</Note>
        )}
      </Panel>

      <Panel
        title="Entry rules"
        subtitle="Every rule must pass before the engine enters. Price range, scope, strategy mode and sizing are set in the filter form."
        right={
          <button type="button" onClick={save} disabled={!dirty || saving}
            style={{ ...buttonStyle, opacity: !dirty || saving ? 0.5 : 1, cursor: !dirty || saving ? 'default' : 'pointer' }}>
            {saving ? 'Saving…' : dirty ? 'Save rules' : 'Saved'}
          </button>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          {([
            ['minQuality', 'Min setup quality', 40, 100, 1, '0–100 ensemble score'],
            ['minRewardRisk', 'Min reward : risk', 1, 10, 0.1, 'strategy levels, at the live price'],
            ['minNetRewardRisk', 'Min R:R after charges', 0.5, 10, 0.05, 'brokerage, STT, fees, GST, stamp'],
            ['confirmSeconds', 'Hold before entry (s)', 2, 300, 1, 'setup must stay unchanged'],
            ['maxSetupAgeMin', 'Max setup age (min)', 0, 120, 1, 'older signals are stale — not taken when a slot frees; 0 = off'],
            ['maxEntriesPerDay', 'Max entries per day', 0, 50, 1, '0 pauses new entries'],
            ['maxEntriesMorning', 'Max morning entries', 0, 50, 1, '09:45–11:30 IST'],
            ['maxEntriesAfternoon', 'Max afternoon entries', 0, 50, 1, '13:30–14:45 IST'],
            ['maxPerSector', 'Max per sector', 1, 50, 1, 'open positions in one NSE industry'],
            ['reentryCooldownMin', 'Re-entry cooldown (min)', 0, 120, 1, 'after a position in the symbol closes'],
            ['maxOpenPositions', 'Max open positions', 1, 50, 1, 'across all strategies'],
            ['maxLeverage', 'Max intraday leverage (×)', 1, 5, 0.5, 'open MIS exposure ÷ capital; risk stays a % of capital'],
            ['maxVwapStretchAtr', 'Max distance from VWAP (ATR)', 0, 20, 0.5, "don't chase a move already this far from VWAP; 0 = off"],
            ['maxPerStrategy', 'Max per strategy', 1, 50, 1, 'open positions one strategy may lead'],
            ['maxSameSide', 'Max same direction', 1, 50, 1, 'open longs, or open shorts'],
            ['autoUniverseSize', 'Auto-picked stocks', 1, 30, 1, "today's movers added to the watchlist"],
            ['autoUniverseMinTurnoverCr', 'Pick min turnover (₹ Cr)', 1, 5000, 1, 'day turnover of an auto-picked stock'],
          ] as const).map(([key, label, min, max, step, hint]) => (
            <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>
              {label}
              <input
                type="number" min={min} max={max} step={step} value={draft[key]}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setDraft({ ...draft, [key]: v });
                }}
                style={inputStyle}
              />
              <span style={{ fontWeight: 400, fontSize: 10.5 }}>{hint}</span>
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Risk management:</span>
          <Chip on={draft.trailStop} onClick={() => setDraft({ ...draft, trailStop: !draft.trailStop })}
            title="Stop follows the price at the initial risk distance, held at the exchange in the bracket order. Changes the exit profile the strategies were validated with.">
            Trailing stop {draft.trailStop ? 'on' : 'off'}
          </Chip>
          <Chip on={draft.pauseLosingStrategies} onClick={() => setDraft({ ...draft, pauseLosingStrategies: !draft.pauseLosingStrategies })}
            title="A strategy whose own last 20+ recorded trades in this mode have negative expectancy after costs stops leading new entries">
            Pause losing strategies {draft.pauseLosingStrategies ? 'on' : 'off'}
          </Chip>
          <Chip on={draft.skipFailedStrategies} onClick={() => setDraft({ ...draft, skipFailedStrategies: !draft.skipFailedStrategies })}
            title="A strategy whose parameters in use FAILED validation in the Strategy Lab does not lead entries in any mode, paper included">
            Skip failed strategies {draft.skipFailedStrategies ? 'on' : 'off'}
          </Chip>
          <Note>Each entry is re-checked at its real size: R:R after round-trip charges must clear the floor above.</Note>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Entry timing:</span>
          <Chip on={draft.closedBarEntries} onClick={() => setDraft({ ...draft, closedBarEntries: !draft.closedBarEntries })}
            title="Intraday setups are read off closed 5-minute bars only, never the bar still forming">
            Closed-bar entries {draft.closedBarEntries ? 'on' : 'off'}
          </Chip>
          <Chip on={draft.htfBias} onClick={() => setDraft({ ...draft, htfBias: !draft.htfBias })}
            title="Intraday entries only in the direction of the 15-minute trend: close vs VWAP, EMA20 vs EMA50, ADX ≥ 20">
            15-min trend filter {draft.htfBias ? 'on' : 'off'}
          </Chip>
          {draft.htfBias && (
            <Chip on={draft.htfBiasStrict} onClick={() => setDraft({ ...draft, htfBiasStrict: !draft.htfBiasStrict })}
              title="Strict: VWAP side, EMA20/50 and ADX must all agree. Off: price on the trade's side of 15-min VWAP and no full 15-min trend against it">
              {draft.htfBiasStrict ? 'Strict: full alignment' : 'VWAP side, no trend against'}
            </Chip>
          )}
          <Note>Entries only 09:45–11:30 and 13:30–14:45 IST. Pending entries cancel at 15:00; intraday positions square off at 15:05.</Note>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Stock selection:</span>
          <Chip on={draft.autoUniverse} onClick={() => setDraft({ ...draft, autoUniverse: !draft.autoUniverse })}
            title="Every 5 minutes from 09:20, pick the day's most liquid stocks that are up and holding their gains, and analyse them with the watchlist">
            Auto-pick today&apos;s movers {draft.autoUniverse ? 'on' : 'off'}
          </Chip>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Segments:</span>
          <Pill color={a.segments.intraday ? 'var(--ok)' : 'var(--muted)'}>Intraday {a.segments.intraday ? 'on' : 'off'}</Pill>
          <Pill color={a.segments.swing ? 'var(--ok)' : 'var(--muted)'}>Swing {a.segments.swing ? 'on' : 'off'}</Pill>
          <Pill color={a.segments.fno ? 'var(--ok)' : 'var(--muted)'}>F&O {a.segments.fno ? 'on' : 'off'}</Pill>
          <Note>Intraday / Swing follow the Strategy mode in the filter form; F&O has its own switch above.</Note>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>
            Strategies allowed to lead an entry {draft.strategies.length === 0 ? '— all' : `— ${draft.strategies.length} selected`}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <Chip on={draft.strategies.length === 0} onClick={() => setDraft({ ...draft, strategies: [] })}>All strategies</Chip>
            {live.strategies.map((st) => (
              <Chip key={st.id} on={draft.strategies.includes(st.id)} onClick={() => toggleStrategy(st.id)}
                title={`${st.style}${st.approved ? ' · has an APPROVED version (eligible in LIVE)' : ' · no APPROVED version — paper only'}${st.verdict ? ` · validation ${st.verdict.status}${st.verdict.oosExpectancyR !== null ? ` (${st.verdict.oosExpectancyR.toFixed(2)}R out-of-sample)` : ''}` : ' · not validated'}`}>
                {st.name} <span style={{ opacity: 0.7 }}>· {st.style === 'SWING' ? 'D' : '5m'}</span>{st.approved ? ' ✓' : ''}
                {st.verdict?.status === 'REJECTED' && <span style={{ color: 'var(--danger)' }}> ✗</span>}
              </Chip>
            ))}
          </div>
          <Note>Every strategy still votes on every stock — this list only limits which one may <em>lead</em> an entry. ✓ = human-approved, required for LIVE. ✗ = failed validation, skipped while “Skip failed strategies” is on.</Note>
        </div>
      </Panel>

      <Panel
        title="Live setups"
        subtitle="Best intraday and swing setup per instrument, ranked by quality. Swing entries are re-priced to the live market."
        right={live.setups.length > 12 ? <Chip on={showAll} onClick={() => setShowAll(!showAll)}>{showAll ? 'Top 12' : `All ${live.setups.length}`}</Chip> : undefined}
      >
        {live.setups.length === 0 ? (
          <Note>No strategy currently sees a setup on the watched instruments. Intraday strategies fire 09:20–14:45 IST on today&apos;s bars; entries are placed 09:45–11:30 and 13:30–14:45.</Note>
        ) : narrow ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {shown.map((s) => (
              <div key={`${s.instrumentKey}|${s.style}`} style={{ border: '1px solid var(--line)', borderLeft: `3px solid ${s.eligible ? 'var(--ok)' : 'var(--line)'}`, borderRadius: 8, padding: '7px 10px', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <span><strong>{s.symbol}</strong> <span style={{ color: sideColor(s.side), fontWeight: 700 }}>{s.side}</span> <span style={{ color: 'var(--muted)' }}>{s.style === 'SWING' ? 'Swing' : 'Intraday'}</span></span>
                  <span style={{ fontWeight: 700, color: qualityColor(s.quality) }}>Q{s.quality} · R:R {num(s.rewardRisk)}</span>
                </div>
                <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--muted)' }}>
                  {rupees(s.entry)} · SL {rupees(s.stopLoss)} · T {rupees(s.target)} · {s.primaryStrategyId}
                </div>
                <div style={{ fontSize: 11, color: s.eligible ? 'var(--ok)' : 'var(--warn)' }}>
                  {s.eligible ? `✓ eligible · ${ROUTE_LABEL[s.route ?? ''] ?? ''}` : s.blockers.join(' · ')}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead><tr style={{ borderBottom: '1px solid var(--line)' }}>
                {['Stock', 'Setup', 'Quality', 'Entry / SL / Target', 'R:R', 'Lead strategy', 'Status'].map((h) => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={`${s.instrumentKey}|${s.style}`} style={{ borderBottom: '1px solid var(--line)', background: s.eligible ? 'var(--ok-subtle, transparent)' : undefined }}>
                    <td style={{ ...td, fontWeight: 700 }}>{s.symbol}</td>
                    <td style={td}>
                      <span style={{ color: sideColor(s.side), fontWeight: 700 }}>{s.side}</span>{' '}
                      <span style={{ color: 'var(--muted)' }}>{s.style === 'SWING' ? 'Swing' : 'Intraday'}</span>
                      <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>held {s.stableSeconds}s{s.partialBar ? ' · forming bar' : ''}</div>
                    </td>
                    <td style={{ ...td, fontWeight: 700, color: qualityColor(s.quality) }}>{s.quality}</td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace', whiteSpace: 'nowrap' }}>
                      {rupees(s.entry)}<div style={{ fontSize: 10.5, color: 'var(--muted)' }}>{rupees(s.stopLoss)} / {rupees(s.target)}</div>
                    </td>
                    <td style={{ ...td, fontFamily: 'ui-monospace, monospace' }}>{num(s.rewardRisk)}</td>
                    <td style={td}>
                      {s.primaryStrategyId}
                      {(s.agreeing.length > 0 || s.conflicting.length > 0) && (
                        <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>+{s.agreeing.length} agree · {s.conflicting.length} oppose</div>
                      )}
                    </td>
                    <td style={td}>
                      {s.eligible
                        ? <Pill color="var(--ok)">✓ {ROUTE_LABEL[s.route ?? ''] ?? 'eligible'}</Pill>
                        : (
                          <ul style={{ margin: 0, paddingLeft: 14, fontSize: 11, color: 'var(--warn)', lineHeight: 1.4 }}>
                            {s.blockers.map((b) => <li key={b}>{b}</li>)}
                          </ul>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Panel title="Decision log" subtitle="What autonomous mode did with each setup it acted on (latest first).">
          {live.autoLog.length === 0 ? <Note>No autonomous decisions yet this session.</Note> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 360, overflowY: 'auto' }}>
              {live.autoLog.map((l) => (
                <div key={`${l.at}-${l.symbol}-${l.style}`} style={{ borderLeft: `3px solid ${OUTCOME_COLOR[l.outcome]}`, paddingLeft: 10 }}>
                  <div style={{ fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
                    <strong>{l.symbol}</strong>
                    <span style={{ color: sideColor(l.side), fontWeight: 700 }}>{l.side}</span>
                    <span style={{ color: 'var(--muted)' }}>{l.style} · {ROUTE_LABEL[l.route] ?? l.route} · Q{l.quality} · {l.strategyId}</span>
                    <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 10.5 }}>{new Date(l.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: OUTCOME_COLOR[l.outcome], fontWeight: 600 }}>{l.outcome.replace('_', ' ')}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{l.detail}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Live watchlist"
          subtitle={`Every stock here is streamed, analysed each cycle and eligible for "All watched" scope. ${watch ? `${watch.default.length} default + ${watch.added.length}/${watch.max} added.` : ''}`}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={addSymbol} onChange={(e) => setAddSymbol(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addToWatch(); }}
              placeholder="NSE symbols, e.g. TATASTEEL, BEL" style={{ ...inputStyle, flex: 1 }}
            />
            <button type="button" onClick={() => void addToWatch()} style={buttonStyle}>Watch</button>
          </div>
          <Note>Tip: add stocks straight from the Market Scanner with its “Watch live” button.</Note>
          {watch && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {watch.default.map((s) => <Pill key={s} color="var(--muted)">{s}</Pill>)}
              {watch.added.map((w) => (
                <span key={w.instrumentKey} title={`${w.name} · ${w.bars} bars today`}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, padding: '2px 4px 2px 8px', borderRadius: 999, border: '1px solid var(--accent)', color: 'var(--accent-fg)', background: 'var(--accent-subtle)' }}>
                  {w.symbol}
                  <button type="button" aria-label={`Stop watching ${w.symbol}`} onClick={() => void removeFromWatch(w.symbol)}
                    style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, padding: '0 4px' }}>×</button>
                </span>
              ))}
            </div>
          )}
          {watch?.autoUniverse && (
            watch.autoUniverse.enabled ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Note kind={watch.autoUniverse.error ? 'warn' : 'muted'}>
                  Auto-picked from {watch.autoUniverse.scanned || 'the whole'} NSE stocks
                  {watch.autoUniverse.refreshedAt ? ` at ${new Date(watch.autoUniverse.refreshedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` : ' — first pick at 09:20, then every 5 min'}
                  {watch.autoUniverse.error ? ` · last refresh failed: ${watch.autoUniverse.error}` : ''}
                </Note>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {watch.autoUniverse.picks.map((s) => <Pill key={s} color="var(--ok)">{s}</Pill>)}
                </div>
              </div>
            ) : <Note>Auto-pick is off — only the stocks above are analysed.</Note>
          )}
        </Panel>
      </div>

      <StrategyLab
        mode={live.mode}
        records={Object.fromEntries(live.strategies.map((st) => [st.id, st.record]))}
        onToast={onToast}
      />
    </div>
  );
}
