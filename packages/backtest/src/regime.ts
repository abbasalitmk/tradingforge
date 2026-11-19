import { atr, sma, closes } from '@tradeforger/indicators';
import type { Dataset, TradeRecord } from './engine.ts';
import { computeMetrics, type Metrics } from './metrics.ts';

export type Regime = 'HIGH_VOL' | 'LOW_VOL' | 'UPTREND' | 'DOWNTREND';

export interface RegimeSlice {
  readonly regime: Regime;
  readonly metrics: Metrics;
}

/**
 * Where does the strategy make and lose money?
 *
 * Every trade is tagged with the market it was entered into: volatility
 * (ATR% at entry above or below that instrument's median) and trend (close
 * above or below its 50-bar SMA). A strategy can be profitable overall and
 * still bleed in one regime — that is the weakness worth a hypothesis
 * ("add a volatility filter"), and the research agent is handed exactly this.
 *
 * Uses only bars up to and including the entry signal bar: no lookahead.
 */
export function regimeBreakdown(
  trades: readonly TradeRecord[],
  datasets: readonly Dataset[],
  capital: number,
): { slices: RegimeSlice[]; weaknesses: string[] } {
  const tagged = new Map<Regime, TradeRecord[]>();
  for (const d of datasets) {
    const a = atr(d.candles, 14);
    const s = sma(closes(d.candles), 50);
    const atrPct = d.candles.map((c, i) => (a[i] != null && c.close > 0 ? (a[i]! / c.close) * 100 : null));
    const known = atrPct.filter((x): x is number => x !== null).sort((x, y) => x - y);
    const median = known.length ? known[Math.floor(known.length / 2)]! : 0;
    const index = new Map(d.candles.map((c, i) => [c.ts, i]));

    for (const t of trades) {
      if (t.symbol !== d.symbol) continue;
      const fill = index.get(t.entryTs);
      if (fill === undefined || fill === 0) continue;
      const i = fill - 1; // the signal bar: the last bar the strategy saw
      const tags: Regime[] = [];
      const v = atrPct[i];
      if (v != null) tags.push(v >= median ? 'HIGH_VOL' : 'LOW_VOL');
      const ma = s[i];
      if (ma != null) tags.push(d.candles[i]!.close >= ma ? 'UPTREND' : 'DOWNTREND');
      for (const r of tags) tagged.set(r, [...(tagged.get(r) ?? []), t]);
    }
  }

  const slices: RegimeSlice[] = (['HIGH_VOL', 'LOW_VOL', 'UPTREND', 'DOWNTREND'] as const)
    .filter((r) => tagged.has(r))
    .map((r) => ({ regime: r, metrics: computeMetrics(tagged.get(r)!, capital) }));

  const minTrades = Math.max(10, Math.ceil(trades.length * 0.15));
  const weaknesses = slices
    .filter((s) => s.metrics.trades >= minTrades && s.metrics.expectancyR < 0)
    .map((s) => `${s.regime}: ${s.metrics.trades} trades at ${s.metrics.expectancyR.toFixed(2)}R `
      + `(win ${(s.metrics.winRate * 100).toFixed(0)}%, PF ${s.metrics.profitFactor.toFixed(2)})`);
  return { slices, weaknesses };
}
