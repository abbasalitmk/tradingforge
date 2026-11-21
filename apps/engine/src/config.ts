import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_LIMITS, type Limits } from '@tradeforger/safety';
import type { Paise } from '@tradeforger/core';

const schema = z.object({
  TF_MODE: z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']).default('PAPER'),
  LIVE_TRADING: z.string().default('false'),

  TF_AUTO_TRADING_MODE: z.enum(['INTRADAY', 'SWING', 'BOTH']).default('BOTH'),
  /** Autonomous entries at boot. Off unless asked for: analysis runs regardless. */
  TF_AUTO_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TF_AUTO_MIN_QUALITY: z.coerce.number().min(40).max(100).default(70),
  TF_AUTO_MIN_RR: z.coerce.number().min(1).max(10).default(1.5),
  TF_ANALYSIS_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(2000),

  UPSTOX_API_KEY: z.string().min(10),
  UPSTOX_API_SECRET: z.string().min(4),
  UPSTOX_REDIRECT_URI: z.string().url().default('https://tradeforger.internal/api/auth/callback'),
  UPSTOX_ANALYTICS_TOKEN: z.string().optional(),
  /** Daily trading token pasted from the Upstox console; the dashboard login replaces it. */
  UPSTOX_ACCESS_TOKEN: z.string().optional(),
  UPSTOX_SANDBOX_TOKEN: z.string().optional(),

  DATABASE_URL: z.string().url().default('postgresql://abba@localhost:5432/tradeforger'),
  REDIS_URL: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_BASE_URL: z.string().url().default('https://generativelanguage.googleapis.com/v1beta/openai'),
  GEMINI_PROJECT_ID: z.string().optional(),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default('qwen/qwen3.8-27b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),

  XAI_API_KEY: z.string().optional(),
  GROK_MODEL: z.string().default('grok-2-latest'),
  GROK_BASE_URL: z.string().url().default('https://api.x.ai/v1'),

  // No default: a token in source is a token everyone with the repo holds.
  TF_ENGINE_TOKEN: z.string().min(32),
  TF_ENGINE_PORT: z.coerce.number().default(4000),
  TF_ENGINE_HOST: z.string().default('0.0.0.0'),

  TF_MAX_SPEND_PER_TRADE: z.coerce.number().default(10_000),
  TF_MAX_DEPLOYED_CAPITAL: z.coerce.number().default(50_000),
  TF_DAILY_LOSS_LIMIT_PCT: z.coerce.number().default(2),

  TF_SIZING_MODE: z.enum(['FIXED_QTY', 'FIXED_BUDGET', 'RISK_BASED']).default('FIXED_BUDGET'),
  TF_FIXED_QTY: z.coerce.number().optional(),
  TF_BUDGET: z.coerce.number().default(10_000),
  TF_RISK_PCT: z.coerce.number().default(1),

  // ── F&O (see docs/04-FNO.md). Off by default; long options unless FUTURES chosen.
  TF_FNO_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  TF_FNO_UNDERLYINGS: z.string().default('NIFTY,BANKNIFTY')
    .transform((v) => v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
  TF_FNO_INSTRUMENT: z.enum(['OPTIONS', 'FUTURES']).default('OPTIONS'),
  TF_FNO_MIN_DTE: z.coerce.number().int().min(0).default(1),
  TF_FNO_TARGET_DELTA: z.coerce.number().min(0.2).max(0.9).default(0.5),
  TF_FNO_MAX_SPREAD_PCT: z.coerce.number().positive().default(3),
  TF_FNO_MAX_PREMIUM_LOSS_PCT: z.coerce.number().min(5).max(80).default(35),
  TF_FNO_MAX_IV: z.coerce.number().positive().default(60),
  TF_FNO_MAX_LOTS: z.coerce.number().int().min(1).default(2),
  TF_FNO_TIME_STOP_MIN: z.coerce.number().int().min(0).default(30),
  TF_FNO_CHAIN_REFRESH_SEC: z.coerce.number().int().min(15).default(60),
});

/** Typed exactly to arm LIVE. Deliberately awkward to type by accident. */
export const LIVE_CONFIRMATION = 'I UNDERSTAND THIS USES REAL MONEY';

export type EngineConfig = z.infer<typeof schema> & { limits: Limits };

/** Parse key=value lines from file */
function readEnvFile(filepath: string, target: Record<string, string>): void {
  try {
    if (!existsSync(filepath)) return;
    const content = readFileSync(filepath, 'utf8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["'](.*)["']$/, '$1');
      if (!target[key]) target[key] = val;
    }
  } catch {
    // Ignore file read error
  }
}

/**
 * Fail-closed configuration with automatic .env / .secrets.local discovery
 * and alias normalization (e.g. UPSTOCK_* -> UPSTOX_*).
 */
export function loadConfig(baseEnv: NodeJS.ProcessEnv = process.env): EngineConfig {
  const fileEnv: Record<string, string> = {};
  readEnvFile(resolve(process.cwd(), '.env'), fileEnv);
  readEnvFile(resolve(process.cwd(), '.env.local'), fileEnv);
  readEnvFile(resolve(process.cwd(), '.secrets.local'), fileEnv);

  const merged: Record<string, string | undefined> = {
    ...fileEnv,
    ...baseEnv,
  };

  // Normalize aliases
  const apiKey = merged['UPSTOX_API_KEY'] || merged['UPSTOCK_API_KEY'] || merged['UPSTOCK_KEY'];
  const apiSecret = merged['UPSTOX_API_SECRET'] || merged['UPSTOCK_API_SECRET'] || merged['UPSTOCK_SECRET'];
  const analyticsToken = merged['UPSTOX_ANALYTICS_TOKEN'] || merged['UPSTOCK_ANALYTICS_KEY'] || merged['UPSTOCK_ANALYTICS_TOKEN'];
  const accessToken = merged['UPSTOX_ACCESS_TOKEN'] || merged['UPSTOCK_ACCESS_TOKEN'];

  const normalized = {
    ...merged,
    UPSTOX_API_KEY: apiKey,
    UPSTOX_API_SECRET: apiSecret,
    UPSTOX_ANALYTICS_TOKEN: analyticsToken,
    UPSTOX_ACCESS_TOKEN: accessToken,
  };

  const parsed = schema.safeParse(normalized);
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
