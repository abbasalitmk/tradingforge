import { IntradayProfile, DEFAULT_INTRADAY, type IntradayParams } from './intraday.ts';
import { SwingProfile, DEFAULT_SWING, type SwingParams } from './swing.ts';
import { type StrategyDefinition, type Params, tagged, clampParams } from './definition.ts';
import { VWAP_PULLBACK } from './strategies/vwapPullback.ts';
import { SUPERTREND_MOMENTUM } from './strategies/supertrendMomentum.ts';
import { BB_SQUEEZE_BREAKOUT } from './strategies/bbSqueeze.ts';
import { RSI_MEAN_REVERSION } from './strategies/rsiMeanReversion.ts';
import { DONCHIAN_BREAKOUT } from './strategies/donchianBreakout.ts';
import { GMMA_TREND } from './strategies/gmma.ts';

// The definition contract lives in definition.ts (so strategy files can use it
// without an import cycle); re-exported here so the catalog's API is unchanged.
export { type Params, type ParamBound, type StrategyDefinition, tagged, clampParams } from './definition.ts';
export { VWAP_PULLBACK, SUPERTREND_MOMENTUM, BB_SQUEEZE_BREAKOUT, RSI_MEAN_REVERSION, DONCHIAN_BREAKOUT, GMMA_TREND };

export const ORB_SUPERTREND: StrategyDefinition = {
  id: 'ORB_SUPERTREND',
  name: 'ORB + Supertrend + VWAP',
  style: 'INTRADAY',
  timeframe: '5m',
  description: '15-min opening range breakout confirmed by Supertrend, EMA9/21, ADX, RVOL and VWAP side.',
  defaults: DEFAULT_INTRADAY as unknown as Params,
  bounds: {
    orbMinutes: { min: 10, max: 30, step: 5 },
    stopAtrMultiple: { min: 1, max: 3, step: 0.25 },
    targetRR: { min: 1.2, max: 3.5, step: 0.25 },
    minRelativeVolume: { min: 1, max: 3, step: 0.25 },
    minAdx: { min: 12, max: 35, step: 1 },
    minConfidence: { min: 50, max: 90, step: 5 },
  },
  create(params) {
    return tagged(this.id, new IntradayProfile(clampParams(this, params) as unknown as IntradayParams));
  },
};

export const EMA_TREND_SWING: StrategyDefinition = {
  id: 'EMA_TREND_SWING',
  name: 'EMA Trend + MACD + RSI Pullback',
  style: 'SWING',
  timeframe: '1d',
  description: 'Daily EMA20/50 trend with MACD and RSI pullback confirmation.',
  defaults: DEFAULT_SWING as unknown as Params,
  bounds: {
    emaFastPeriod: { min: 10, max: 30, step: 2 },
    emaSlowPeriod: { min: 40, max: 100, step: 5 },
    stopAtrMultiple: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.5, max: 4, step: 0.25 },
    minAdx: { min: 12, max: 35, step: 1 },
    minConfidence: { min: 50, max: 90, step: 5 },
  },
  create(params) {
    return tagged(this.id, new SwingProfile(clampParams(this, params) as unknown as SwingParams));
  },
};

/** Every strategy the system knows. Add new ones here — nowhere else. */
export const STRATEGY_CATALOG: StrategyDefinition[] = [
  ORB_SUPERTREND,
  EMA_TREND_SWING,
  VWAP_PULLBACK,
  SUPERTREND_MOMENTUM,
  BB_SQUEEZE_BREAKOUT,
  RSI_MEAN_REVERSION,
  DONCHIAN_BREAKOUT,
  GMMA_TREND,
];

export const getStrategy = (id: string): StrategyDefinition | undefined =>
  STRATEGY_CATALOG.find((d) => d.id === id);
