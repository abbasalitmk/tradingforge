import type { Signal } from '@tradeforger/core';
import type { StrategyContext, StrategyProfile } from './profile.ts';

/*
 * The catalog's building blocks live here rather than in catalog.ts so that
 * individual strategy files can import them without creating an import cycle
 * (catalog.ts imports every strategy to list it). catalog.ts re-exports all of
 * this, so its public API is unchanged.
 */

export type Params = Readonly<Record<string, number>>;
export interface ParamBound { readonly min: number; readonly max: number; readonly step: number }

/**
 * A strategy as the research loop sees it: an id, numeric parameters with
 * hard bounds, and a factory. Bounds serve two masters — robustness sweeps
 * perturb inside them, and an AI-proposed change outside them is refused.
 */
export interface StrategyDefinition {
  readonly id: string;
  readonly name: string;
  readonly style: 'INTRADAY' | 'SWING';
  /** Candle interval the strategy reads. */
  readonly timeframe: '5m' | '1d';
  readonly description: string;
  readonly defaults: Params;
  readonly bounds: Readonly<Record<string, ParamBound>>;
  create(params?: Params): StrategyProfile;
}

/** Stamp every signal with the catalog id that produced it. */
export function tagged(id: string, profile: StrategyProfile): StrategyProfile {
  return {
    style: profile.style,
    name: profile.name,
    warmupBars: profile.warmupBars,
    evaluate(ctx: StrategyContext): Signal | null {
      const s = profile.evaluate(ctx);
      return s ? { ...s, strategyId: id } : null;
    },
  };
}

/** Merge proposed params over defaults, clamped to bounds. Unknown keys are dropped. */
export function clampParams(def: StrategyDefinition, params: Params = {}): Params {
  const out: Record<string, number> = { ...def.defaults };
  for (const [k, v] of Object.entries(params)) {
    const b = def.bounds[k];
    if (!b || !Number.isFinite(v)) continue;
    out[k] = Math.min(b.max, Math.max(b.min, v));
  }
  return out;
}
