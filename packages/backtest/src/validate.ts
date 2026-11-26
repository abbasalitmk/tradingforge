import {
  type Params, type ParamBound, type StrategyDefinition, clampParams,
} from '@tradeforger/strategy';
import { scaleCosts } from './costs.ts';
import {
  type BacktestConfig, type BacktestWindow, type Dataset, type PreparedBacktest,
  type TradeRecord, type TrailConfig, candlesForTimeframe, defaultBacktestFor, istMidnight, prepareBacktest,
} from './engine.ts';
import { type Metrics, computeMetrics } from './metrics.ts';
import { regimeBreakdown, type RegimeSlice } from './regime.ts';

/**
 * The approval gate.
 *
 * A candidate (human- or AI-proposed) is APPROVED only if every independent
 * check passes. Nothing here is tunable by the candidate: the thresholds live
 * in `ValidationConfig`, chosen by the operator, and the data split is by
 * calendar time so a strategy cannot be "validated" on the same period it was
 * fitted to. The principle: never let AI approve its own strategy.
 */
export interface ValidationConfig {
  /** Share of the calendar range used as in-sample (the rest is out-of-sample). */
  inSampleFraction: number;
  /** Consecutive calendar windows across the full range for walk-forward. */
  folds: number;
  /** Minimum trades in the full run — fewer is an anecdote, not a sample. */
  minTrades: number;
  /** In-sample profit factor floor. */
  minProfitFactor: number;
  /** Out-of-sample expectancy (R) must be strictly above this. */
  minOosExpectancyR: number;
  /** Share of folds that must be profitable (expectancyR > 0 and PF ≥ 1). */
  minFoldPassRate: number;
  /** Each bounded param is perturbed by ± this percent. */
  sensitivityPct: number;
  /** Share of perturbations that must keep expectancyR > 0. */
  minStableFraction: number;
  /** Costs AND slippage are multiplied by this for the stress run. */
  costStressMultiplier: number;
}

export const DEFAULT_VALIDATION: ValidationConfig = {
  inSampleFraction: 0.7,
  folds: 4,
  minTrades: 30,
  minProfitFactor: 1.1,
  minOosExpectancyR: 0,
  minFoldPassRate: 0.6,
  sensitivityPct: 20,
  minStableFraction: 0.6,
  costStressMultiplier: 2,
};

/** Recommended staged trail matching live execution: cost-buffered breakeven + 1.25 ATR trail. */
export const INTRADAY_STAGED_TRAIL: TrailConfig = {
  breakevenR: 1.2,
  breakevenLockR: 0.35,
  trailFromR: 1.6,
  trailAtr: 1.25,
};

/** Live-parity intraday backtest defaults for Strategy Lab validation. */
export function liveParityBacktestFor(def: Pick<StrategyDefinition, 'style' | 'timeframe'>): BacktestConfig {
  const base = defaultBacktestFor(def);
  if (def.style === 'SWING') return base;
  return {
    ...base,
    entrySessionsOnly: true,
    htfBias: true,
    minStopPct: def.timeframe === '15m' ? 0.75 : 0.5,
    maxVwapStretchAtr: 5,
    stopClusterGuard: true,
    targetR: 2.5,
    maxTargetDailyAtr: 1.5,
    minRewardRisk: 1.5,
    trail: INTRADAY_STAGED_TRAIL,
  };
}

export type CheckName =
  | 'MIN_TRADES' | 'IN_SAMPLE' | 'OUT_OF_SAMPLE'
  | 'WALK_FORWARD' | 'PARAMETER_STABILITY' | 'COST_STRESS';

export interface ValidationCheck {
  name: CheckName;
  passed: boolean;
  detail: string;
}

export interface SensitivityPoint {
  param: string;
  value: number;
  expectancyR: number;
  profitFactor: number;
  trades: number;
}

export interface ValidationReport {
  strategyId: string;
  /** The params actually tested (proposal merged over defaults, clamped). */
  params: Params;
  symbols: string[];
  status: 'APPROVED' | 'REJECTED';
  checks: ValidationCheck[];
  full: Metrics;
  inSample: Metrics;
  outOfSample: Metrics;
  folds: Metrics[];
  sensitivity: SensitivityPoint[];
  costStress: Metrics;
  /** Performance by market regime at entry; see regime.ts. */
  regimes: RegimeSlice[];
  /** Regimes with enough trades and negative expectancy — the research agent's targets. */
  weaknesses: string[];
  generatedAt: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Snap a boundary forward to IST midnight, so no session is cut in half. */
function ceilIstMidnight(ts: number): number {
  const m = istMidnight(ts);
  return m === ts ? ts : m + DAY_MS;
}

interface TimeRange { start: number; end: number }

function timeRange(datasets: readonly Dataset[]): TimeRange | null {
  let start = Infinity;
  let end = -Infinity;
  for (const d of datasets) {
    const first = d.candles[0];
    const last = d.candles[d.candles.length - 1];
    if (!first || !last) continue;
    start = Math.min(start, first.ts);
    end = Math.max(end, last.ts);
  }
  return Number.isFinite(start) ? { start, end } : null;
}

/** Calendar boundary at fraction f of the range, snapped to IST midnight. */
const boundaryAt = (r: TimeRange, f: number): number =>
  ceilIstMidnight(r.start + (r.end - r.start) * f);

/** Pool trades from every symbol into one entry-ordered list. */
function pool(lists: readonly TradeRecord[][]): TradeRecord[] {
  return lists.flat().sort((a, b) => a.entryTs - b.entryTs || a.symbol.localeCompare(b.symbol));
}

function runAll(
  prepared: readonly PreparedBacktest[], window: BacktestWindow, cfg: BacktestConfig,
): TradeRecord[] {
  return pool(prepared.map((p) => p.run(window, cfg)));
}

const r2 = (n: number): string => n.toFixed(2);
const pct0 = (n: number): string => `${Math.round(n * 100)}%`;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function snapToStep(v: number, b: ParamBound): number {
  const snapped = b.step > 0 ? b.min + Math.round((v - b.min) / b.step) * b.step : v;
  return round6(Math.min(b.max, Math.max(b.min, snapped)));
}

/**
 * The ± perturbations of every bounded param around the candidate's value,
 * snapped to the param's step and clamped to its bounds. A perturbation that
 * snaps back onto the base value is pushed one step further; one that still
 * equals the base (pinned at a bound) is dropped as uninformative.
 */
export function perturbations(
  def: StrategyDefinition, params: Params, pct: number,
): Array<{ param: string; value: number; params: Params }> {
  const base = clampParams(def, params);
  const out: Array<{ param: string; value: number; params: Params }> = [];
  for (const [name, bound] of Object.entries(def.bounds)) {
    const b0 = base[name];
    if (b0 === undefined) continue;
    const seen = new Set<number>();
    for (const dir of [-1, 1] as const) {
      let v = snapToStep(b0 * (1 + (dir * pct) / 100), bound);
      if (v === b0 && bound.step > 0) v = snapToStep(b0 + dir * bound.step, bound);
      const clamped: number | undefined = clampParams(def, { ...base, [name]: v })[name];
      if (clamped === undefined || clamped === b0 || seen.has(clamped)) continue;
      seen.add(clamped);
      out.push({ param: name, value: clamped, params: { ...base, [name]: clamped } });
    }
  }
  return out;
}

/**
 * Run every independent check and return APPROVED only if all pass.
 *
 * - MIN_TRADES on the full pooled run.
 * - IN_SAMPLE: first `inSampleFraction` of the calendar range.
 * - OUT_OF_SAMPLE: the remainder. Both segments may use earlier bars as
 *   indicator warmup, but only trades ENTERED inside the segment count, and
 *   a trade still open at the segment's end is closed there (END_OF_DATA).
 * - WALK_FORWARD: `folds` consecutive calendar windows over the full range;
 *   each fold must show expectancyR > 0 and PF ≥ 1.
 * - PARAMETER_STABILITY: each bounded param at ±sensitivityPct%.
 * - COST_STRESS: charges and slippage multiplied by costStressMultiplier.
 */
export function validateStrategy(
  def: StrategyDefinition,
  params: Params | undefined,
  datasets: readonly Dataset[],
  cfg: ValidationConfig = DEFAULT_VALIDATION,
  bt: BacktestConfig = defaultBacktestFor(def),
  now: number = Date.now(),
): ValidationReport {
  const t0 = performance.now();
  const resolved = clampParams(def, params);
  const simDatasets = def.timeframe === '15m'
    ? datasets.map((d) => ({ ...d, candles: candlesForTimeframe(d.candles, '15m') }))
    : datasets;
  const prepared = simDatasets.map((d) => prepareBacktest(def, resolved, d, bt));
  const range = timeRange(simDatasets);
  const m = (trades: TradeRecord[]): Metrics => computeMetrics(trades, bt.capital);

  const fullTrades = runAll(prepared, {}, bt);
  const full = m(fullTrades);
  const regimes = regimeBreakdown(fullTrades, simDatasets, bt.capital);

  const split = range ? boundaryAt(range, cfg.inSampleFraction) : 0;
  const inSample = m(range ? runAll(prepared, { toTs: split }, bt) : []);
  const outOfSample = m(range ? runAll(prepared, { fromTs: split }, bt) : []);

  const folds: Metrics[] = [];
  if (range && cfg.folds > 0) {
    for (let k = 0; k < cfg.folds; k++) {
      const window: BacktestWindow = {};
      if (k > 0) window.fromTs = boundaryAt(range, k / cfg.folds);
      if (k < cfg.folds - 1) window.toTs = boundaryAt(range, (k + 1) / cfg.folds);
      folds.push(m(runAll(prepared, window, bt)));
    }
  }

  const stressed: BacktestConfig = {
    ...bt,
    costs: scaleCosts(bt.costs, cfg.costStressMultiplier),
    slippageBps: bt.slippageBps * cfg.costStressMultiplier,
  };
  const costStress = m(runAll(prepared, {}, stressed));

  const sensitivity: SensitivityPoint[] = perturbations(def, resolved, cfg.sensitivityPct)
    .map(({ param, value, params: p }) => {
      const metrics = m(pool(simDatasets.map((d) => prepareBacktest(def, p, d, bt).run({}, bt))));
      return {
        param, value,
        expectancyR: metrics.expectancyR,
        profitFactor: metrics.profitFactor,
        trades: metrics.trades,
      };
    });

  // ---- checks --------------------------------------------------------------
  const checks: ValidationCheck[] = [];

  checks.push({
    name: 'MIN_TRADES',
    passed: full.trades >= cfg.minTrades,
    detail: `${full.trades} trades across ${datasets.length} symbol(s); need at least ${cfg.minTrades}.`,
  });

  checks.push({
    name: 'IN_SAMPLE',
    passed: inSample.profitFactor >= cfg.minProfitFactor && inSample.expectancyR > 0,
    detail: `In-sample (${pct0(cfg.inSampleFraction)}): ${inSample.trades} trades, PF ${r2(inSample.profitFactor)} `
      + `(need ≥ ${r2(cfg.minProfitFactor)}), expectancy ${r2(inSample.expectancyR)}R (need > 0).`,
  });

  checks.push({
    name: 'OUT_OF_SAMPLE',
    passed: outOfSample.expectancyR > cfg.minOosExpectancyR && outOfSample.profitFactor >= 1,
    detail: `Out-of-sample: ${outOfSample.trades} trades, expectancy ${r2(outOfSample.expectancyR)}R `
      + `(need > ${r2(cfg.minOosExpectancyR)}), PF ${r2(outOfSample.profitFactor)} (need ≥ 1.00).`,
  });

  const foldPasses = folds.filter((f) => f.expectancyR > 0 && f.profitFactor >= 1).length;
  const foldRate = folds.length > 0 ? foldPasses / folds.length : 0;
  checks.push({
    name: 'WALK_FORWARD',
    passed: folds.length > 0 && foldRate >= cfg.minFoldPassRate,
    detail: `${foldPasses}/${folds.length} time folds profitable (${pct0(foldRate)}; need ≥ `
      + `${pct0(cfg.minFoldPassRate)}). Fold expectancy: ${folds.map((f) => `${r2(f.expectancyR)}R`).join(', ') || 'n/a'}.`,
  });

  const stable = sensitivity.filter((s) => s.expectancyR > 0).length;
  const stableFrac = sensitivity.length > 0 ? stable / sensitivity.length : 1;
  const worst = sensitivity.reduce<SensitivityPoint | null>(
    (w, s) => (w === null || s.expectancyR < w.expectancyR ? s : w), null);
  checks.push({
    name: 'PARAMETER_STABILITY',
    passed: stableFrac >= cfg.minStableFraction,
    detail: sensitivity.length === 0
      ? 'No bounded parameters to perturb; nothing to overfit.'
      : `${stable}/${sensitivity.length} perturbations (±${cfg.sensitivityPct}%) stay profitable `
        + `(${pct0(stableFrac)}; need ≥ ${pct0(cfg.minStableFraction)}). Worst: `
        + `${worst!.param}=${worst!.value} at ${r2(worst!.expectancyR)}R.`,
  });

  checks.push({
    name: 'COST_STRESS',
    passed: costStress.expectancyR > 0,
    detail: `With costs and slippage ×${cfg.costStressMultiplier}: expectancy ${r2(costStress.expectancyR)}R `
      + `(base ${r2(full.expectancyR)}R), costs ₹${Math.round(costStress.totalCosts)}; need > 0.`,
  });

  return {
    strategyId: def.id,
    params: resolved,
    symbols: datasets.map((d) => d.symbol),
    status: checks.every((c) => c.passed) ? 'APPROVED' : 'REJECTED',
    checks,
    full,
    inSample,
    outOfSample,
    folds,
    sensitivity,
    costStress,
    regimes: regimes.slices,
    weaknesses: regimes.weaknesses,
    generatedAt: now,
    durationMs: Math.max(performance.now() - t0, Number.EPSILON),
  };
}

// ---------------------------------------------------------------------------

export interface SensitivityGrid {
  paramA: string;
  paramB: string;
  valuesA: number[];
  valuesB: number[];
  /** expectancyR[a][b] for valuesA[a] × valuesB[b]. */
  expectancyR: number[][];
  profitFactor: number[][];
  trades: number[][];
}

/** Up to `steps` values evenly spread across a bound, snapped to its step. */
function gridValues(b: ParamBound, steps: number): number[] {
  const n = Math.max(2, steps);
  const out = new Set<number>();
  for (let k = 0; k < n; k++) out.add(snapToStep(b.min + ((b.max - b.min) * k) / (n - 1), b));
  return [...out].sort((x, y) => x - y);
}

/**
 * 2-D robustness heatmap: expectancy across a grid of two params with every
 * other param held at the candidate's value. A real edge shows a plateau; an
 * overfit one shows a lone hot cell.
 */
export function sensitivityGrid(
  def: StrategyDefinition,
  paramA: string,
  paramB: string,
  datasets: readonly Dataset[],
  opts: { params?: Params; bt?: BacktestConfig; steps?: number } = {},
): SensitivityGrid {
  const bA = def.bounds[paramA];
  const bB = def.bounds[paramB];
  if (!bA || !bB) throw new Error(`sensitivityGrid: ${!bA ? paramA : paramB} has no bounds on ${def.id}`);
  const bt = opts.bt ?? defaultBacktestFor(def);
  const base = clampParams(def, opts.params);
  const valuesA = gridValues(bA, opts.steps ?? 5);
  const valuesB = gridValues(bB, opts.steps ?? 5);

  const expectancyR: number[][] = [];
  const profitFactor: number[][] = [];
  const trades: number[][] = [];
  for (const a of valuesA) {
    const rowE: number[] = [];
    const rowP: number[] = [];
    const rowT: number[] = [];
    for (const b of valuesB) {
      const p = { ...base, [paramA]: a, [paramB]: b };
      const met = computeMetrics(
        pool(datasets.map((d) => prepareBacktest(def, p, d, bt).run({}, bt))),
        bt.capital,
      );
      rowE.push(met.expectancyR);
      rowP.push(met.profitFactor);
      rowT.push(met.trades);
    }
    expectancyR.push(rowE);
    profitFactor.push(rowP);
    trades.push(rowT);
  }
  return { paramA, paramB, valuesA, valuesB, expectancyR, profitFactor, trades };
}
