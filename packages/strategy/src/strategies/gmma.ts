import { istMinutes, type Candle, type Side, type Signal, type TradingStyle } from '@tradeforger/core';
import { atr, closes, ema, latest, relativeVolume } from '@tradeforger/indicators';
import {
  type StrategyProfile, type StrategyContext, type Confluence, scoreConfluence,
} from '../profile.ts';
import { type StrategyDefinition, tagged, clampParams } from '../definition.ts';
import { intradayFrame, clampStop, riskGeometry, buildSignal, closeLocation, fmt } from './common.ts';

const SHORT = [3, 5, 8, 10, 12, 15];
const LONG = [30, 35, 40, 45, 50, 60];

export interface GmmaParams {
  readonly atrPeriod: number;
  /** The ribbons must have separated within this many bars — fresh, not late. */
  readonly freshBars: number;
  /** Bars back to measure long-ribbon slope and separation growth. */
  readonly slopeBars: number;
  readonly stopBufferAtr: number;
  readonly minStopAtr: number;
  readonly maxStopAtr: number;
  readonly targetRR: number;
  readonly minRelativeVolume: number;
  readonly minConfidence: number;
}

export const DEFAULT_GMMA: GmmaParams = {
  atrPeriod: 14,
  freshBars: 6,
  slopeBars: 5,
  stopBufferAtr: 0.25,
  minStopAtr: 0.75,
  maxStopAtr: 2.5,
  targetRR: 2,
  minRelativeVolume: 1.2,
  minConfidence: 60,
};

/** Aggregate 5-min bars into 15-min bars anchored to the 09:15 open. */
export function resample15(candles: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  let curKey = '';
  for (const c of candles) {
    const d = new Date(c.ts);
    const slot = Math.floor((istMinutes(d) - (9 * 60 + 15)) / 15);
    const key = `${Math.floor(c.ts / 86_400_000)}:${slot}`;
    if (key !== curKey || cur === null) {
      if (cur) out.push(cur);
      cur = { ...c };
      curKey = key;
    } else {
      cur = {
        ts: cur.ts, open: cur.open, close: c.close, volume: cur.volume + c.volume,
        high: Math.max(cur.high, c.high), low: Math.min(cur.low, c.low),
      };
    }
  }
  if (cur) out.push(cur);
  return out;
}

const ribbons = (c: readonly number[], at: number): { short: number[]; long: number[] } | null => {
  const pick = (periods: number[]): number[] | null => {
    const vals = periods.map((p) => ema(c, p)[at] ?? null);
    return vals.every((v) => v !== null) ? (vals as number[]) : null;
  };
  const short = pick(SHORT);
  const long = pick(LONG);
  return short && long ? { short, long } : null;
};

/** Signed gap between the ribbons: > 0 short fully above long, < 0 fully below, 0 tangled. */
function separation(r: { short: number[]; long: number[] }): number {
  const up = Math.min(...r.short) - Math.max(...r.long);
  if (up > 0) return up;
  const down = Math.max(...r.short) - Math.min(...r.long);
  return down < 0 ? down : 0;
}

/**
 * Guppy Multiple Moving Average (GMMA) trend entry.
 *
 * Six fast EMAs are the traders, six slow EMAs the investors. A trade is only
 * worth taking when the two groups have cleanly SEPARATED (no overlap), the
 * investor ribbon itself is sloping the same way, and the gap is widening —
 * agreement between short- and long-horizon participants. The separation
 * must be fresh: a ribbon that split an hour ago is a move already paid for.
 *
 * The 15-minute ribbon must agree, the multi-timeframe confirmation the GUPPY
 * screener in the reference Zerodha bots used (5/15-minute consensus).
 * The stop sits beyond the slow ribbon: if price closes through the
 * investors' average, the trend thesis is wrong.
 */
export class GmmaProfile implements StrategyProfile {
  readonly style: TradingStyle = 'INTRADAY';
  readonly name = 'GMMA Ribbon Trend (Guppy)';
  readonly warmupBars: number;
  private readonly p: GmmaParams;

  constructor(params: GmmaParams = DEFAULT_GMMA) {
    this.p = params;
    this.warmupBars = 60 + params.slopeBars + params.freshBars + 5;
  }

  evaluate(ctx: StrategyContext): Signal | null {
    const frame = intradayFrame(ctx, this.warmupBars);
    if (!frame) return null;
    const { candles, last } = frame;
    const p = this.p;
    const c = closes(candles);
    const n = c.length;

    const now = ribbons(c, n - 1);
    const then = ribbons(c, n - 1 - p.slopeBars);
    if (!now || !then) return null;
    const sepNow = separation(now);
    if (sepNow === 0) return null;
    const side: Side = sepNow > 0 ? 'BUY' : 'SELL';
    const dir = side === 'BUY' ? 1 : -1;

    // Fresh: within freshBars the ribbons were still tangled or opposite.
    let fresh = false;
    for (let k = 1; k <= p.freshBars; k++) {
      const r = ribbons(c, n - 1 - k);
      if (r && separation(r) * dir <= 0) { fresh = true; break; }
    }

    const atrNow = latest(atr(candles, p.atrPeriod));
    if (atrNow === null || atrNow <= 0) return null;

    const longNow = now.long.reduce((a, b) => a + b, 0) / LONG.length;
    const longThen = then.long.reduce((a, b) => a + b, 0) / LONG.length;
    const sepThen = separation(then);

    const tf15 = resample15(candles);
    const c15 = closes(tf15);
    const e15f = latest(ema(c15, 5));
    const e15s = latest(ema(c15, 20));
    const rvol = latest(relativeVolume(candles, 20));
    const price = last.close;

    const checks: Confluence[] = [
      { name: 'separated', passed: true, weight: 3, detail: `GMMA ribbons separated ${side === 'BUY' ? 'bullish' : 'bearish'} (${fmt(Math.abs(sepNow) / atrNow, 1)} ATR gap)` },
      { name: 'fresh', passed: fresh, weight: 3, detail: `Separation began within ${p.freshBars} bars` },
      { name: 'longSlope', passed: (longNow - longThen) * dir > 0, weight: 2, detail: `Investor ribbon sloping ${side === 'BUY' ? 'up' : 'down'}` },
      { name: 'expanding', passed: Math.abs(sepNow) > Math.abs(sepThen) && sepThen * dir >= 0, weight: 2, detail: 'Ribbon gap widening' },
      { name: 'mtf15', passed: e15f !== null && e15s !== null && (e15f - e15s) * dir > 0, weight: 3, detail: '15-min trend agrees' },
      {
        name: 'priceSide', weight: 1,
        passed: side === 'BUY' ? price >= Math.max(...now.short) : price <= Math.min(...now.short),
        detail: `Price ${side === 'BUY' ? 'above' : 'below'} the trader ribbon`,
      },
      { name: 'volume', passed: rvol !== null && rvol >= p.minRelativeVolume, weight: 1, detail: `RVOL ${fmt(rvol)}x` },
      { name: 'closeStrong', passed: closeLocation(last, side) >= 0.6, weight: 1, detail: 'Trigger bar closed near its extreme' },
    ];
    // Without a fresh separation this is a late entry into an old move.
    if (!fresh) return null;
    const confidence = scoreConfluence(checks);
    if (confidence < p.minConfidence) return null;

    const ribbonEdge = side === 'BUY' ? Math.min(...now.long) : Math.max(...now.long);
    const structural = (price - ribbonEdge) * dir + p.stopBufferAtr * atrNow;
    const stopDistance = clampStop(structural, atrNow, p.minStopAtr, p.maxStopAtr);
    const geometry = riskGeometry(side, price, stopDistance, stopDistance * p.targetRR);
    if (!geometry) return null;

    return buildSignal({
      ctx, style: this.style, side, geometry, atr: atrNow, confidence, checks,
      indicators: { atr: atrNow, separation: sepNow, longRibbon: longNow, ema15Fast: e15f ?? 0, ema15Slow: e15s ?? 0, rvol: rvol ?? 0 },
    });
  }
}

export const GMMA_TREND: StrategyDefinition = {
  id: 'GMMA_TREND',
  name: 'GMMA Ribbon Trend (Guppy)',
  style: 'INTRADAY',
  timeframe: '5m',
  description: 'Fresh, clean separation of the Guppy short (3–15) and long (30–60) EMA ribbons, long ribbon sloping, 15-min trend agreeing.',
  defaults: DEFAULT_GMMA as unknown as StrategyDefinition['defaults'],
  bounds: {
    freshBars: { min: 2, max: 12, step: 1 },
    slopeBars: { min: 3, max: 10, step: 1 },
    stopBufferAtr: { min: 0, max: 1, step: 0.05 },
    minStopAtr: { min: 0.25, max: 1.5, step: 0.25 },
    maxStopAtr: { min: 1.5, max: 4, step: 0.25 },
    targetRR: { min: 1.2, max: 4, step: 0.25 },
    minRelativeVolume: { min: 0.8, max: 3, step: 0.1 },
    minConfidence: { min: 40, max: 90, step: 5 },
  },
  create(params) {
    return tagged('GMMA_TREND', new GmmaProfile(clampParams(GMMA_TREND, params) as unknown as GmmaParams));
  },
};
