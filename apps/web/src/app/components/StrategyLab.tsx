'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Panel, Pill, Note, api, num, buttonStyle } from './ui.tsx';

interface Metrics {
  trades: number;
  winRate: number;
  profitFactor: number;
  expectancyR: number;
  netPnl: number;
  maxDrawdownPct: number;
}

interface Version {
  id: string;
  strategyId: string;
  version: number;
  status: 'CANDIDATE' | 'VALIDATED' | 'REJECTED' | 'APPROVED' | 'RETIRED';
  origin: 'DEFAULT' | 'AI_PROPOSAL' | 'MANUAL';
  hypothesis: string | null;
  params: Record<string, number>;
  validation: {
    status: 'APPROVED' | 'REJECTED';
    checks: Array<{ name: string; passed: boolean; detail: string }>;
    outOfSample: Metrics;
    full: Metrics;
    weaknesses: string[];
    generatedAt: number;
  } | null;
  createdAt: number;
}

interface Job {
  id: string;
  kind: 'VALIDATE' | 'PROPOSE';
  strategyId: string;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  stage: string;
  error: string | null;
  result: 'VALIDATED' | 'REJECTED' | null;
  startedAt: number;
}

interface ResearchResponse {
  strategies: Array<{ id: string; name: string; style: 'INTRADAY' | 'SWING'; timeframe: string; description: string; versions: Version[] }>;
  jobs: Job[];
  aiAvailable: boolean;
}

export interface LiveRecord { trades: number; expectancyR: number }

const STATUS_COLOR: Record<Version['status'], string> = {
  APPROVED: 'var(--ok)', VALIDATED: 'var(--accent)', CANDIDATE: 'var(--muted)', REJECTED: 'var(--danger)', RETIRED: 'var(--muted)',
};

const th: React.CSSProperties = { padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, verticalAlign: 'top' };
const sub: React.CSSProperties = { fontSize: 10.5, color: 'var(--muted)', marginTop: 2 };
const small = (color: string): React.CSSProperties => ({ ...buttonStyle, padding: '3px 9px', fontSize: 10.5, background: 'transparent', color, border: `1px solid ${color}`, boxShadow: 'none' });

/**
 * The research loop, operable from the dashboard: validate a strategy on
 * history (walk-forward, out-of-sample, cost stress), approve the version that
 * passed — LIVE autonomous entries use only approved versions — and ask the AI
 * for a bounded parameter change aimed at the weaknesses validation found.
 * Approval is the one step that is always a person's.
 */
export default function StrategyLab({ records, mode, onToast }: {
  records: Readonly<Record<string, LiveRecord | null>>;
  mode: string;
  onToast: (msg: string, kind?: 'ok' | 'error') => void;
}) {
  const [data, setData] = useState<ResearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<ResearchResponse>('/api/proxy/research/strategies');
    if (!r.ok) { setError(r.error); return; }
    setError(null);
    setData(r.data);
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const run = async (key: string, path: string, body: Record<string, unknown>, ok: string) => {
    setBusy(key);
    const r = await api(`/api/proxy/research/${path}`, body);
    setBusy(null);
    if (!r.ok) return onToast(`${ok} failed: ${r.error}`, 'error');
    onToast(ok);
    void load();
  };

  const approve = (v: Version, name: string) => {
    const oos = v.validation?.outOfSample;
    if (!window.confirm(
      `Approve ${name} v${v.version} for LIVE autonomous trading?\n\n`
      + (oos ? `Out-of-sample: ${oos.trades} trades · ${(oos.winRate * 100).toFixed(0)}% wins · ${oos.expectancyR.toFixed(2)}R expectancy · PF ${oos.profitFactor.toFixed(2)}\n\n` : '')
      + 'Past results do not guarantee future returns. Any previously approved version of this strategy is retired.',
    )) return;
    void run(v.id, 'approve', { versionId: v.id }, `${name} v${v.version} approved`);
  };

  if (!data) {
    return (
      <Panel title="Strategy lab" subtitle="Validate and approve strategies for LIVE trading">
        <Note kind={error ? 'danger' : 'muted'}>{error ? `Research unavailable: ${error}` : 'Loading strategies…'}</Note>
      </Panel>
    );
  }

  const running = data.jobs.filter((j) => j.status === 'RUNNING');
  const approvedCount = data.strategies.filter((s) => s.versions.some((v) => v.status === 'APPROVED')).length;

  return (
    <Panel
      title="Strategy lab"
      subtitle="LIVE entries use only human-approved versions. Validation runs walk-forward, out-of-sample, parameter-sensitivity and cost-stress checks on history."
      right={<Pill color={approvedCount ? 'var(--ok)' : 'var(--warn)'}>{approvedCount}/{data.strategies.length} approved for LIVE</Pill>}
    >
      {approvedCount === 0 && (
        <Note kind="warn">No strategy is approved, so armed LIVE autonomous mode will place no orders. Validate a strategy, review its out-of-sample record, then approve it. Paper mode trades every strategy regardless.</Note>
      )}
      {running.length > 0 && (
        <Note>Running: {running.map((j) => `${j.kind.toLowerCase()} ${j.strategyId} — ${j.stage}`).join(' · ')}</Note>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 980 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--line)' }}>
            {['Strategy', 'Version', 'Validation (out-of-sample)', `${mode === 'LIVE' ? 'Live' : 'Paper'} record`, 'Actions'].map((h) => <th key={h} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {data.strategies.map((st) => {
              const latest = [...st.versions].sort((a, b) => b.version - a.version)[0];
              const approved = st.versions.find((v) => v.status === 'APPROVED');
              const shown = latest ?? approved;
              const val = shown?.validation ?? null;
              const oos = val?.outOfSample;
              const passed = val ? val.checks.filter((c) => c.passed).length : 0;
              const rec = records[st.id] ?? null;
              const job = data.jobs.find((j) => j.strategyId === st.id && j.status === 'RUNNING');
              const lastJob = data.jobs.filter((j) => j.strategyId === st.id).sort((a, b) => b.startedAt - a.startedAt)[0];
              return (
                <tr key={st.id} style={{ borderBottom: '1px solid var(--line)' }}>
                  <td style={td}>
                    <strong>{st.name}</strong>
                    <div style={sub}>{st.id} · {st.style === 'SWING' ? 'Swing · daily' : 'Intraday · 5-min'}</div>
                  </td>
                  <td style={td}>
                    {shown ? <Pill color={STATUS_COLOR[shown.status]}>v{shown.version} {shown.status}</Pill> : '—'}
                    <div style={sub}>{approved && approved !== shown ? `live on v${approved.version}` : shown?.origin === 'AI_PROPOSAL' ? 'AI proposal' : shown?.origin.toLowerCase()}</div>
                    {shown?.hypothesis && <div style={{ ...sub, maxWidth: 220, whiteSpace: 'normal' }}>“{shown.hypothesis}”</div>}
                  </td>
                  <td style={td}>
                    {oos ? (
                      <>
                        <span style={{ color: oos.expectancyR > 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>{oos.expectancyR >= 0 ? '+' : ''}{num(oos.expectancyR)}R</span>
                        {' '}· {oos.trades} trades · {(oos.winRate * 100).toFixed(0)}% wins · PF {num(oos.profitFactor)}
                        <div style={sub}>max DD {num(oos.maxDrawdownPct, 1)}% · {passed}/{val!.checks.length} checks passed</div>
                        {val!.checks.filter((c) => !c.passed).slice(0, 2).map((c) => <div key={c.name} style={{ ...sub, color: 'var(--danger)', whiteSpace: 'normal', maxWidth: 300 }}>✗ {c.detail}</div>)}
                      </>
                    ) : <span style={{ color: 'var(--muted)' }}>not validated</span>}
                    {lastJob?.status === 'FAILED' && <div style={{ ...sub, color: 'var(--danger)' }}>last run failed: {lastJob.error}</div>}
                  </td>
                  <td style={td}>
                    {rec ? (
                      <>
                        <span style={{ color: rec.expectancyR > 0 ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>{rec.expectancyR >= 0 ? '+' : ''}{num(rec.expectancyR)}R</span>
                        <div style={sub}>{rec.trades} trades{rec.trades < 20 ? ' · too few to judge' : ''}</div>
                      </>
                    ) : <span style={{ color: 'var(--muted)' }}>no trades yet</span>}
                  </td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>
                    {job ? <span style={{ fontSize: 11, color: 'var(--accent)' }}>{job.stage}…</span> : (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {shown && shown.status !== 'RETIRED' && (
                          <button type="button" disabled={busy !== null} style={small('var(--accent)')}
                            onClick={() => void run(shown.id, 'validate', { versionId: shown.id }, `Validating ${st.name} v${shown.version}`)}>
                            {val ? 'Re-validate' : 'Validate'}
                          </button>
                        )}
                        {shown?.status === 'VALIDATED' && (
                          <button type="button" disabled={busy !== null} style={small('var(--ok)')} onClick={() => approve(shown, st.name)}>Approve</button>
                        )}
                        {data.aiAvailable && val && (
                          <button type="button" disabled={busy !== null} style={small('var(--muted)')}
                            title="Ask the AI for a bounded parameter change aimed at the weaknesses validation found; the result is a new CANDIDATE you validate yourself"
                            onClick={() => void run(`p-${st.id}`, 'propose', { strategyId: st.id }, `AI proposal requested for ${st.name}`)}>
                            AI improve
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Note>Validation passing is evidence, not a promise: markets change. The engine also pauses any strategy whose own recorded trades show negative expectancy over 20+ trades.</Note>
    </Panel>
  );
}
