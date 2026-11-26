import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import type { Candle } from '@tradeforger/core';
import { istDateKey, type Clock } from '@tradeforger/core';
import type { UpstoxClient } from '@tradeforger/upstox';
import { backfill } from '@tradeforger/data';
import type { Dataset, ValidationReport } from '@tradeforger/backtest';
import { getStrategy, clampParams, type Params, type StrategyDefinition } from '@tradeforger/strategy';
import type { StrategyRegistry, StrategyVersion } from './registry.ts';

export interface ResearchJob {
  readonly id: string;
  readonly kind: 'VALIDATE' | 'PROPOSE';
  readonly strategyId: string;
  versionId: string | null;
  status: 'RUNNING' | 'DONE' | 'FAILED';
  stage: string;
  readonly startedAt: number;
  finishedAt: number | null;
  error: string | null;
  hypothesis: string | null;
  result: 'VALIDATED' | 'REJECTED' | null;
}

export interface AiConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
}

const DAY = 86_400_000;

const proposalSchema = z.object({
  hypothesis: z.string().min(10).max(600),
  params: z.record(z.string(), z.number()),
});

const RESEARCH_PROMPT = `You are a quantitative research agent for an NSE trading system.
You receive one strategy's validation report: metrics in-sample, out-of-sample,
per walk-forward fold, a parameter-sensitivity sweep, cost stress, and the
pass/fail checks, and performance by market regime with the losing regimes
listed as weaknesses. Find the most likely cause of weakness and propose ONE
testable hypothesis that changes at most TWO parameters, strictly inside the
given bounds. Prefer changes the sensitivity data supports; never propose a
change only because it would fit the in-sample period better.

Respond with ONLY JSON: {"hypothesis":"<cause and expected effect, 1-3 sentences>","params":{"<name>":<number>}}
No markdown, no preamble.`;

/**
 * The research loop from evaluation to a new candidate version.
 *
 *   validate(version) — historical data → independent validation (worker) →
 *                       VALIDATED or REJECTED in the registry.
 *   propose(strategy) — the AI reads the latest report and proposes a bounded
 *                       parameter change → new CANDIDATE → validate().
 *
 * Neither path can approve anything. A proposal that passes every check sits
 * at VALIDATED until a human approves it.
 */
export class ResearchLab {
  readonly jobs: ResearchJob[] = [];
  private readonly client: UpstoxClient;
  private readonly clock: Clock;
  private readonly registry: StrategyRegistry;
  private readonly aiProviders: readonly AiConfig[];
  private readonly symbols: () => Array<{ instrumentKey: string; symbol: string }>;
  private seq = 0;

  constructor(opts: {
    client: UpstoxClient; clock: Clock; registry: StrategyRegistry;
    ai: AiConfig | readonly AiConfig[] | null;
    symbols: () => Array<{ instrumentKey: string; symbol: string }>;
  }) {
    this.client = opts.client;
    this.clock = opts.clock;
    this.registry = opts.registry;
    this.aiProviders = opts.ai ? (Array.isArray(opts.ai) ? opts.ai : [opts.ai]) : [];
    this.symbols = opts.symbols;
  }

  get hasAi(): boolean {
    return this.aiProviders.length > 0;
  }

  get busy(): boolean {
    return this.jobs.some((j) => j.status === 'RUNNING');
  }

  private newJob(kind: ResearchJob['kind'], strategyId: string, versionId: string | null): ResearchJob {
    this.seq += 1;
    const job: ResearchJob = {
      id: `research-${this.clock.ms()}-${this.seq}`, kind, strategyId, versionId, status: 'RUNNING',
      stage: 'starting', startedAt: this.clock.ms(), finishedAt: null, error: null, hypothesis: null, result: null,
    };
    this.jobs.unshift(job);
    if (this.jobs.length > 30) this.jobs.pop();
    return job;
  }

  private finish(job: ResearchJob, error?: unknown): void {
    job.status = error === undefined ? 'DONE' : 'FAILED';
    job.error = error === undefined ? null : error instanceof Error ? error.message : String(error);
    job.stage = job.status === 'DONE' ? 'done' : 'failed';
    job.finishedAt = this.clock.ms();
  }

  /** Historical candles for the research universe. Fails rather than validating on a gap. */
  async datasets(def: StrategyDefinition, days: number): Promise<Dataset[]> {
    const to = istDateKey(new Date(this.clock.ms() - DAY));
    const from = istDateKey(new Date(this.clock.ms() - days * DAY));
    const out: Dataset[] = [];
    for (const s of this.symbols()) {
      const r = def.timeframe === '1d'
        ? await backfill(this.client, s.instrumentKey, 'days', 1, from, to)
        : await backfill(this.client, s.instrumentKey, 'minutes', 5, from, to);
      if (!r.ok) {
        // One symbol's gap should not stop a run, but an expired token or a ban
        // fails every symbol: say so rather than validate on whatever is left.
        console.warn(`[research] ${def.id}: no ${def.timeframe} history for ${s.symbol} — ${r.error.message}`);
        continue;
      }
      if (r.value.length > 0) out.push({ symbol: s.symbol, instrumentKey: s.instrumentKey, candles: r.value });
    }
    if (out.length === 0) throw new Error('no historical data for any research symbol');
    return out;
  }

  /** Historical NIFTY 50 5-min bars for live-parity intraday market & RS filtering. */
  async marketHistory(days: number): Promise<Candle[]> {
    const to = istDateKey(new Date(this.clock.ms() - DAY));
    const from = istDateKey(new Date(this.clock.ms() - days * DAY));
    const r = await backfill(this.client, 'NSE_INDEX|Nifty 50', 'minutes', 5, from, to);
    if (!r.ok) {
      console.warn(`[research] Nifty 50 market history unavailable — ${r.error.message}`);
      return [];
    }
    return r.value;
  }

  private runWorker(strategyId: string, params: Params, datasets: Dataset[], marketSeries: Candle[]): Promise<ValidationReport> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./research-worker.ts', import.meta.url), {
        workerData: { strategyId, params, datasets, marketSeries },
      });
      w.once('message', (m: { ok: true; report: ValidationReport } | { ok: false; error: string }) => {
        void w.terminate();
        if (m.ok) resolve(m.report);
        else reject(new Error(m.error));
      });
      w.once('error', reject);
    });
  }

  validate(versionId: string, days?: number): ResearchJob {
    const v = this.registry.get(versionId);
    if (!v) throw new Error(`unknown version ${versionId}`);
    const job = this.newJob('VALIDATE', v.strategyId, versionId);
    void this.doValidate(job, v, days).then(() => this.finish(job), (e) => this.finish(job, e));
    return job;
  }

  private async doValidate(job: ResearchJob, v: StrategyVersion, days?: number): Promise<void> {
    const def = getStrategy(v.strategyId);
    if (!def) throw new Error(`unknown strategy ${v.strategyId}`);
    const spanDays = days ?? (def.timeframe === '1d' ? 1100 : 365);
    job.stage = 'loading history';
    const [data, marketSeries] = await Promise.all([
      this.datasets(def, spanDays),
      def.timeframe === '1d' ? Promise.resolve([]) : this.marketHistory(spanDays),
    ]);
    job.stage = `validating on ${data.length} symbols`;
    const report = await this.runWorker(v.strategyId, v.params, data, marketSeries);
    const updated = await this.registry.recordValidation(v.id, report.status === 'APPROVED', report);
    // The report's own word is "APPROVED"; the registry translates it to VALIDATED.
    job.result = updated.status === 'REJECTED' ? 'REJECTED' : 'VALIDATED';
  }

  propose(strategyId: string): ResearchJob {
    if (this.aiProviders.length === 0) throw new Error('no AI provider configured (GEMINI_API_KEY / GROQ_API_KEY)');
    const def = getStrategy(strategyId);
    if (!def) throw new Error(`unknown strategy ${strategyId}`);
    const job = this.newJob('PROPOSE', strategyId, null);
    void this.doPropose(job, def).then(() => this.finish(job), (e) => this.finish(job, e));
    return job;
  }

  private async doPropose(job: ResearchJob, def: StrategyDefinition): Promise<void> {
    const base = this.registry.list(def.id).find((v) => v.validation !== null && v.validation !== undefined)
      ?? this.registry.list(def.id)[0];
    if (!base) throw new Error('no version to improve on');
    if (!base.validation) {
      job.stage = 'validating baseline first';
      await this.doValidate(job, base);
    }
    job.stage = 'asking research agent';
    const proposal = await this.ask(def, base);
    const params = clampParams(def, { ...base.params, ...proposal.params });
    const changed = Object.keys(params).filter((k) => params[k] !== base.params[k]);
    if (changed.length === 0) throw new Error('research agent proposed no effective change');
    if (changed.length > 2) throw new Error(`research agent changed ${changed.length} parameters; at most 2 allowed`);

    const v = await this.registry.add(def.id, params, 'AI_PROPOSAL', proposal.hypothesis);
    job.versionId = v.id;
    job.hypothesis = proposal.hypothesis;
    await this.doValidate(job, v);
  }

  private async ask(def: StrategyDefinition, base: StrategyVersion): Promise<z.infer<typeof proposalSchema>> {
    const report = base.validation as Partial<ValidationReport>;
    const errors: string[] = [];
    for (const ai of this.aiProviders) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${ai.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ai.apiKey}` },
          body: JSON.stringify({
            model: ai.model,
            temperature: 0.2,
            max_tokens: 500,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: RESEARCH_PROMPT },
              {
                role: 'user',
                content: JSON.stringify({
                  strategy: { id: def.id, description: def.description, style: def.style, timeframe: def.timeframe },
                  current_params: base.params,
                  bounds: def.bounds,
                  checks: report.checks,
                  full: report.full, in_sample: report.inSample, out_of_sample: report.outOfSample,
                  folds: report.folds, sensitivity: report.sensitivity, cost_stress: report.costStress,
                  regimes: report.regimes, weaknesses: report.weaknesses,
                }),
              },
            ],
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`${ai.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const text = body.choices?.[0]?.message?.content ?? '';
        const parsed = proposalSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`${ai.model} invalid proposal: ${parsed.error.message}`);
        return parsed.data;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(`research agent failed (${errors.join('; ')})`);
  }
}
