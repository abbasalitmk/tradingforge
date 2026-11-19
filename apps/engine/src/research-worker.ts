import { parentPort, workerData } from 'node:worker_threads';
import { validateStrategy, type Dataset } from '@tradeforger/backtest';
import { getStrategy, type Params } from '@tradeforger/strategy';

/**
 * Runs one validation off the main thread. A walk-forward with a parameter
 * sweep is seconds of CPU; on the engine's thread that would freeze tick
 * handling and exit management for the duration.
 */
interface Input { strategyId: string; params: Params; datasets: Dataset[] }

const input = workerData as Input;
try {
  const def = getStrategy(input.strategyId);
  if (!def) throw new Error(`unknown strategy ${input.strategyId}`);
  const report = validateStrategy(def, input.params, input.datasets);
  parentPort?.postMessage({ ok: true, report });
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
