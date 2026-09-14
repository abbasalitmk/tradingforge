import { z } from 'zod';
import type { Signal } from '@tradeforger/core';

/**
 * The model's response contract.
 *
 * Strict, small, and machine-checkable. Free-text output is never parsed for
 * meaning — `rationale` is for the trade journal, and nothing downstream reads
 * it. Anything failing this schema is discarded entirely.
 */
export const verdictSchema = z.object({
  verdict: z.enum(['CONFIRM', 'REJECT', 'CAUTION']),
  confidence: z.number().int().min(0).max(100),
  risk_flags: z.array(z.string()).max(10),
  rationale: z.string().max(600),
});
export type Verdict = z.infer<typeof verdictSchema>;

export interface AiDecision {
  readonly verdict: Verdict['verdict'];
  readonly confidence: number;
  readonly riskFlags: readonly string[];
  readonly rationale: string;
  /** Multiplier applied to position size. Never above 1. */
  readonly sizeMultiplier: number;
  readonly blocked: boolean;
  readonly latencyMs: number;
  readonly model: string;
  /** True when the model was unreachable and we fell through to indicators. */
  readonly fellBack: boolean;
}

/**
 * The asymmetry that makes an LLM safe to have in this loop.
 *
 * CONFIRM changes nothing — it cannot raise size, widen a target, loosen a
 * stop, or override a circuit breaker. CAUTION halves size. REJECT blocks.
 *
 * So the worst an LLM failure can cost is a missed trade. It can never cause an
 * unbounded loss, which is the only property that justifies putting a
 * probabilistic component anywhere near an order path.
 */
export function applyVerdict(v: Verdict): { sizeMultiplier: number; blocked: boolean } {
  switch (v.verdict) {
    case 'REJECT': return { sizeMultiplier: 0, blocked: true };
    case 'CAUTION': return { sizeMultiplier: 0.5, blocked: false };
    case 'CONFIRM': return { sizeMultiplier: 1, blocked: false };
  }
}

/** Indicator-only fallback: proceed at full size, unblocked. */
export function fallbackDecision(reason: string, latencyMs: number, model: string): AiDecision {
  return {
    verdict: 'CONFIRM',
    confidence: 0,
    riskFlags: [],
    rationale: `AI unavailable (${reason}); proceeding on deterministic signal only`,
    sizeMultiplier: 1,
    blocked: false,
    latencyMs,
    model,
    fellBack: true,
  };
}

const SYSTEM_PROMPT = `You are a risk reviewer for an automated Indian equity trading system.

You receive a trade candidate that a deterministic indicator engine has ALREADY
approved. Your job is to find reasons NOT to take it. You cannot make a trade
larger, better, or more likely — you can only confirm, caution, or reject.

Respond with ONLY a JSON object:
{"verdict":"CONFIRM|REJECT|CAUTION","confidence":0-100,"risk_flags":["..."],"rationale":"one or two sentences"}

REJECT if the setup is internally contradictory, the risk:reward is worse than
stated, or the stop sits somewhere price will obviously take it out.
CAUTION if the setup is plausible but weak — thin volume, late in the session,
conflicting timeframes, or an extended move.
CONFIRM only if the setup is coherent and the risk geometry is sound.

Be terse. No markdown, no preamble, no code fences.`;

export interface ConfirmerConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl: string;
  /** Hard deadline. A scalping signal is stale in seconds; a slow answer is a
   *  wrong answer, so we fall back rather than wait. */
  readonly timeoutMs: number;
}

export const DEFAULT_AI_CONFIG: Omit<ConfirmerConfig, 'apiKey'> = {
  // Groq, not xAI: gsk_ keys are Groq Cloud, and its sub-second inference is
  // what makes an inline confirmation step viable at all.
  //
  // Model chosen by measurement, not reputation. Benchmarked 2026-09-14 on
  // three fixtures (sound R:R 2.0, stop-above-entry, R:R 0.2):
  //
  //   qwen/qwen3.8-27b       p50  535ms   3/3 correct
  //   openai/gpt-oss-20b     p50  753ms   1/3 (missed an inverted stop)
  //   openai/gpt-oss-120b    p50 1195ms   0/3 usable
  //
  // The gpt-oss family emits reasoning tokens before its JSON, so it exhausts
  // max_tokens and the schema parse fails — it is bigger but unusable here.
  model: 'qwen/qwen3.8-27b',
  baseUrl: 'https://api.groq.com/openai/v1',
  // ~3x the measured p50. Tight enough that a stalled call cannot hold up an
  // order, loose enough that a normal call is not thrown away.
  timeoutMs: 1500,
};

/** Compact, structured payload. The model never sees free-form prose. */
export function buildPayload(signal: Signal, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    symbol: signal.symbol,
    side: signal.side,
    style: signal.style,
    entry: signal.entry / 100,
    stop_loss: signal.stopLoss / 100,
    target: signal.target / 100,
    risk_reward: Number(
      (Math.abs(signal.target - signal.entry) / Math.abs(signal.entry - signal.stopLoss)).toFixed(2),
    ),
    atr: Number(signal.atr.toFixed(2)),
    engine_confidence: signal.confidence,
    reasons: signal.reasons,
    indicators: Object.fromEntries(
      Object.entries(signal.indicators).map(([k, v]) => [k, Number(v.toFixed(2))]),
    ),
    ...extra,
  });
}

export class Confirmer {
  private readonly cfg: ConfirmerConfig;

  constructor(cfg: ConfirmerConfig) {
    this.cfg = cfg;
  }

  async review(signal: Signal, extra: Record<string, unknown> = {}): Promise<AiDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);

    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: this.cfg.model,
          temperature: 0,
          max_tokens: 300,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPayload(signal, extra) },
          ],
        }),
        signal: controller.signal,
      });

      const latency = Date.now() - started;
      if (!res.ok) return fallbackDecision(`http ${res.status}`, latency, this.cfg.model);

      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return fallbackDecision('empty response', latency, this.cfg.model);

      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        return fallbackDecision('non-JSON response', latency, this.cfg.model);
      }

      const parsed = verdictSchema.safeParse(raw);
      if (!parsed.success) {
        // A malformed verdict is discarded, not partially trusted.
        return fallbackDecision('schema mismatch', latency, this.cfg.model);
      }

      const { sizeMultiplier, blocked } = applyVerdict(parsed.data);
      return {
        verdict: parsed.data.verdict,
        confidence: parsed.data.confidence,
        riskFlags: parsed.data.risk_flags,
        rationale: parsed.data.rationale,
        sizeMultiplier,
        blocked,
        latencyMs: latency,
        model: this.cfg.model,
        fellBack: false,
      };
    } catch (e) {
      const latency = Date.now() - started;
      const aborted = e instanceof Error && e.name === 'AbortError';
      return fallbackDecision(aborted ? 'timeout' : 'network', latency, this.cfg.model);
    } finally {
      clearTimeout(timer);
    }
  }
}
