import type { Signal, Product, Clock } from '@tradeforger/core';
import type { StrategyProfile, StrategyContext } from './profile.ts';
import { IntradayProfile } from './intraday.ts';
import { SwingProfile } from './swing.ts';

export type AutoTradingStrategyMode = 'INTRADAY' | 'SWING' | 'BOTH';

export interface EvaluatorOptions {
  readonly clock: Clock;
  readonly mode?: AutoTradingStrategyMode;
  readonly intradayProfile?: IntradayProfile;
  readonly swingProfile?: SwingProfile;
}

export interface MultiTimeframeContext {
  readonly instrumentKey: string;
  readonly symbol: string;
  /** 5m or 15m intraday candles */
  readonly intradayCandles: readonly import('@tradeforger/core').Candle[];
  /** Daily candles for swing and higher-tf trend confirmation */
  readonly dailyCandles: readonly import('@tradeforger/core').Candle[];
  readonly clock: Clock;
}

export interface EvaluatedSignal {
  readonly signal: Signal;
  readonly product: Product;
  readonly profileName: string;
}

/**
 * Strategy Manager orchestrating Intraday, Swing, or Dual-mode auto trading.
 */
export class StrategyManager {
  private mode: AutoTradingStrategyMode;
  private readonly intraday: IntradayProfile;
  private readonly swing: SwingProfile;
  private readonly clock: Clock;

  constructor(opts: EvaluatorOptions) {
    this.mode = opts.mode ?? 'INTRADAY';
    this.clock = opts.clock;
    this.intraday = opts.intradayProfile ?? new IntradayProfile();
    this.swing = opts.swingProfile ?? new SwingProfile();
  }

  getMode(): AutoTradingStrategyMode {
    return this.mode;
  }

  setMode(mode: AutoTradingStrategyMode): void {
    this.mode = mode;
  }

  evaluate(ctx: MultiTimeframeContext): EvaluatedSignal[] {
    const results: EvaluatedSignal[] = [];

    // Intraday evaluation
    if (this.mode === 'INTRADAY' || this.mode === 'BOTH') {
      const intradayCtx: StrategyContext = {
        instrumentKey: ctx.instrumentKey,
        symbol: ctx.symbol,
        candles: ctx.intradayCandles,
        higherTf: ctx.dailyCandles,
        clock: this.clock,
      };
      const signal = this.intraday.evaluate(intradayCtx);
      if (signal) {
        results.push({
          signal,
          product: 'I',
          profileName: this.intraday.name,
        });
      }
    }

    // Swing evaluation
    if (this.mode === 'SWING' || this.mode === 'BOTH') {
      const swingCtx: StrategyContext = {
        instrumentKey: ctx.instrumentKey,
        symbol: ctx.symbol,
        candles: ctx.dailyCandles.length > 0 ? ctx.dailyCandles : ctx.intradayCandles,
        higherTf: [],
        clock: this.clock,
      };
      const signal = this.swing.evaluate(swingCtx);
      if (signal) {
        results.push({
          signal,
          product: 'D',
          profileName: this.swing.name,
        });
      }
    }

    return results;
  }
}

