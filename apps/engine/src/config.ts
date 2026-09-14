import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from '@tradeforger/safety';
import type { Paise } from '@tradeforger/core';

const schema = z.object({
  TF_MODE: z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']).default('PAPER'),
  LIVE_TRADING: z.string().default('false'),

  UPSTOX_API_KEY: z.string().min(10),
  UPSTOX_API_SECRET: z.string().min(4),
  UPSTOX_REDIRECT_URI: z.string().url(),
  UPSTOX_ANALYTICS_TOKEN: z.string().optional(),
  UPSTOX_SANDBOX_TOKEN: z.string().optional(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().optional(),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('qwen/qwen3.8-27b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  TF_ENGINE_TOKEN: z.string().min(32),
  TF_ENGINE_PORT: z.coerce.number().default(4000),

  TF_MAX_SPEND_PER_TRADE: z.coerce.number().default(10_000),
  TF_MAX_DEPLOYED_CAPITAL: z.coerce.number().default(50_000),
  TF_DAILY_LOSS_LIMIT_PCT: z.coerce.number().default(2),

  TF_SIZING_MODE: z.enum(['FIXED_QTY', 'FIXED_BUDGET', 'RISK_BASED']).default('FIXED_BUDGET'),
  TF_FIXED_QTY: z.coerce.number().optional(),
  TF_BUDGET: z.coerce.number().default(10_000),
  TF_RISK_PCT: z.coerce.number().default(1),
});

export type EngineConfig = z.infer<typeof schema> & { limits: Limits };

/**
 * Fail-closed configuration.
 *
 * The process refuses to start on a missing or malformed variable rather than
 * defaulting to something plausible. A trading engine that boots with a
 * silently-defaulted risk limit is worse than one that does not boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EngineConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`invalid engine configuration:\n  ${keys.join('\n  ')}`);
  }
  const c = parsed.data;
  return {
    ...c,
    limits: {
      ...DEFAULT_LIMITS,
      maxSpendPerTradePaise: Math.round(c.TF_MAX_SPEND_PER_TRADE * 100) as Paise,
      maxDeployedCapitalPaise: Math.round(c.TF_MAX_DEPLOYED_CAPITAL * 100) as Paise,
      dailyLossPct: c.TF_DAILY_LOSS_LIMIT_PCT,
    },
  };
}
