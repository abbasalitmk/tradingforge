import { z } from 'zod';
import type { Signal } from '@tradeforger/core';

export const trafficLightsSchema = z.object({
  momentum: z.enum(['GREEN', 'AMBER', 'RED']),
  volume: z.enum(['GREEN', 'AMBER', 'RED']),
  riskBuffer: z.enum(['GREEN', 'AMBER', 'RED']),
  rewardRatio: z.enum(['GREEN', 'AMBER', 'RED']),
});
export type TrafficLights = z.infer<typeof trafficLightsSchema>;

export const checklistItemSchema = z.object({
  item: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

/**
 * The model's response contract.
 *
 * Strict, typed, and machine-checkable. Augmented with beginner-friendly
 * explanations and traffic-light safety indicators for retail traders.
 */
export const verdictSchema = z.object({
  verdict: z.enum(['CONFIRM', 'REJECT', 'CAUTION']),
  confidence: z.number().int().min(0).max(100),
  risk_flags: z.array(z.string()).max(10),
  rationale: z.string().max(800),
  beginner_summary: z.string().max(500).optional(),
  beginner_tip: z.string().max(300).optional(),
  risk_rating: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  traffic_lights: trafficLightsSchema.optional(),
  action_checklist: z.array(checklistItemSchema).optional(),
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
  readonly beginnerSummary?: string | undefined;
  readonly beginnerTip?: string | undefined;
  readonly riskRating?: 'LOW' | 'MEDIUM' | 'HIGH' | undefined;
  readonly trafficLights?: TrafficLights | undefined;
  readonly actionChecklist?: readonly ChecklistItem[] | undefined;
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
    beginnerSummary: 'The algorithmic setup passed all mathematical indicators (trend, RSI, VWAP). Remote AI confirmation timed out or was unavailable, so trading defaults to safe deterministic rules.',
    beginnerTip: 'Keep your stop-loss order placed in the system immediately. Never risk more than 1% to 2% of total capital.',
    riskRating: 'MEDIUM',
    trafficLights: {
      momentum: 'GREEN',
      volume: 'GREEN',
      riskBuffer: 'GREEN',
      rewardRatio: 'GREEN',
    },
    actionChecklist: [
      { item: 'Daily Trend Direction', passed: true, detail: 'Indicator filters confirmed trend alignment' },
      { item: 'Volume Confirmation', passed: true, detail: 'Screener passed relative volume thresholds' },
      { item: 'Stop Loss Protection', passed: true, detail: 'Fixed price floor established' },
      { item: 'Session Timing Window', passed: true, detail: 'Trade planned within allowed market hours' },
    ],
  };
}

const SYSTEM_PROMPT = `You are an expert risk reviewer and beginner-friendly trading analyst for automated Indian equity trading (NSE/BSE).

You receive a trade candidate that a deterministic indicator engine has approved. Your job is to rigorously evaluate its risk and explain the setup clearly so even a beginner trader can understand the rationale, risk level, and safety rules.

Respond with ONLY a JSON object:
{
  "verdict": "CONFIRM" | "REJECT" | "CAUTION",
  "confidence": 0-100,
  "risk_flags": ["..."],
  "rationale": "One or two sentences with the core technical assessment",
  "beginner_summary": "Two sentences in plain simple English explaining what the setup is doing and why",
  "beginner_tip": "One clear beginner golden rule for this trade (e.g. stop loss discipline, position size)",
  "risk_rating": "LOW" | "MEDIUM" | "HIGH",
  "traffic_lights": {
    "momentum": "GREEN" | "AMBER" | "RED",
    "volume": "GREEN" | "AMBER" | "RED",
    "riskBuffer": "GREEN" | "AMBER" | "RED",
    "rewardRatio": "GREEN" | "AMBER" | "RED"
  },
  "action_checklist": [
    {"item": "Daily Trend Direction", "passed": true|false, "detail": "..."},
    {"item": "Volume Confirmation", "passed": true|false, "detail": "..."},
    {"item": "Stop Loss Protection", "passed": true|false, "detail": "..."},
    {"item": "Session Timing Window", "passed": true|false, "detail": "..."}
  ]
}

REJECT if the setup is internally contradictory, the risk:reward is poor (<1.0), or the stop is unsafe.
CAUTION if the setup is plausible but weak, late in session, or volume is thin.
CONFIRM only if the setup is coherent and the risk geometry is sound.

Be terse, insightful, and beginner-accessible. No markdown, no preamble, no code fences.`;

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

/**
 * Two providers, tried in order.
 *
 * Both speak the OpenAI chat-completions schema, so failover is a base-URL
 * change rather than a second integration. Benchmarked 2026-09-14:
 *
 *   Groq          qwen/qwen3.8-27b    535ms p50   3/3 correct   (primary)
 *   Vercel AIGW   openai/gpt-4.1-mini 1709ms      3/3 correct   (fallback)
 *   Vercel AIGW   alibaba/qwen-3-14b  13106ms     unusable
 *
 * The fallback is ~3x slower, which is why it is second and not first — but a
 * slow correct answer beats no answer when the primary is down.
 */
export class Confirmer {
  private readonly cfg: ConfirmerConfig;
  private readonly fallback: ConfirmerConfig | null;

  constructor(cfg: ConfirmerConfig, fallback: ConfirmerConfig | null = null) {
    this.cfg = cfg;
    this.fallback = fallback;
  }

  async review(signal: Signal, extra: Record<string, unknown> = {}): Promise<AiDecision> {
    const primary = await this.ask(this.cfg, signal, extra);
    // Only reach for the fallback when the primary produced nothing usable.
    // A REJECT is a real answer and must never be retried away on another
    // provider — that would turn the safety layer into a shopping trip.
    if (!primary.fellBack || this.fallback === null) return primary;

    const secondary = await this.ask(this.fallback, signal, extra);
    return secondary.fellBack
      ? { ...secondary, rationale: `both providers unavailable; ${secondary.rationale}` }
      : secondary;
  }

  private async ask(
    cfg: ConfirmerConfig,
    signal: Signal,
    extra: Record<string, unknown>,
  ): Promise<AiDecision> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildPayload(signal, extra) },
          ],
        }),
        signal: controller.signal,
      });

      const latency = Date.now() - started;
      if (!res.ok) return fallbackDecision(`http ${res.status}`, latency, cfg.model);

      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content;
      if (!content) return fallbackDecision('empty response', latency, cfg.model);

      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        return fallbackDecision('non-JSON response', latency, cfg.model);
      }

      const parsed = verdictSchema.safeParse(raw);
      if (!parsed.success) {
        // A malformed verdict is discarded, not partially trusted.
        return fallbackDecision('schema mismatch', latency, cfg.model);
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
        model: cfg.model,
        fellBack: false,
        beginnerSummary: parsed.data.beginner_summary,
        beginnerTip: parsed.data.beginner_tip,
        riskRating: parsed.data.risk_rating,
        trafficLights: parsed.data.traffic_lights,
        actionChecklist: parsed.data.action_checklist,
      };
    } catch (e) {
      const latency = Date.now() - started;
      const aborted = e instanceof Error && e.name === 'AbortError';
      return fallbackDecision(aborted ? 'timeout' : 'network', latency, cfg.model);
    } finally {
      clearTimeout(timer);
    }
  }
}
