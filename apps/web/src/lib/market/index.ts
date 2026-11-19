import { NextResponse } from 'next/server';
import { z } from 'zod';
import { SystemClock } from '@tradeforger/core';
import { TokenStore, UpstoxClient } from '@tradeforger/upstox';
import { AiReviewer } from '@tradeforger/ai';
import { MarketService, MarketError } from './service.ts';

export { MarketService, MarketError } from './service.ts';

// Read separately from lib/env.ts: market analysis must keep working when the
// engine settings are missing or wrong. Defaults match apps/engine/src/config.ts.
const schema = z.object({
  UPSTOX_ANALYTICS_TOKEN: z.string().min(20).optional(),
  XAI_API_KEY: z.string().min(1).optional(),
  GROK_MODEL: z.string().min(1).default('grok-2-latest'),
  GROK_BASE_URL: z.string().url().default('https://api.x.ai/v1'),
  GROQ_API_KEY: z.string().min(1).optional(),
  GROQ_MODEL: z.string().min(1).default('qwen/qwen3.8-27b'),
  GROQ_BASE_URL: z.string().url().default('https://api.groq.com/openai/v1'),
});

let service: MarketService | null = null;

/** The process-wide service, or null when no analytics token is configured. */
export function market(): MarketService | null {
  if (service) return service;
  const cfg = schema.parse({
    UPSTOX_ANALYTICS_TOKEN: process.env['UPSTOX_ANALYTICS_TOKEN'] || process.env['UPSTOCK_ANALYTICS_KEY'] || undefined,
    XAI_API_KEY: process.env['XAI_API_KEY'] || undefined,
    GROK_MODEL: process.env['GROK_MODEL'] || undefined,
    GROK_BASE_URL: process.env['GROK_BASE_URL'] || undefined,
    GROQ_API_KEY: process.env['GROQ_API_KEY'] || undefined,
    GROQ_MODEL: process.env['GROQ_MODEL'] || undefined,
    GROQ_BASE_URL: process.env['GROQ_BASE_URL'] || undefined,
  });
  if (!cfg.UPSTOX_ANALYTICS_TOKEN) return null;

  // Analytics token only: this client can read market data and nothing else.
  const tokens = new TokenStore(SystemClock, { analyticsToken: cfg.UPSTOX_ANALYTICS_TOKEN });
  service = new MarketService({
    client: new UpstoxClient(tokens, { clock: SystemClock }),
    clock: SystemClock,
    ai: new AiReviewer({
      clock: SystemClock,
      grokConfig: cfg.XAI_API_KEY
        ? { apiKey: cfg.XAI_API_KEY, model: cfg.GROK_MODEL, baseUrl: cfg.GROK_BASE_URL, timeoutMs: 4_000 }
        : null,
      groqConfig: cfg.GROQ_API_KEY
        ? { apiKey: cfg.GROQ_API_KEY, model: cfg.GROQ_MODEL, baseUrl: cfg.GROQ_BASE_URL, timeoutMs: 4_000 }
        : null,
    }),
  });
  return service;
}

const noStore = { 'cache-control': 'no-store' };

/** Runs a market call and maps every outcome to JSON the dashboard understands. */
export async function respond(run: (m: MarketService) => Promise<unknown>): Promise<NextResponse> {
  const m = market();
  if (!m) {
    return NextResponse.json(
      { error: 'analytics_token_missing', message: 'UPSTOX_ANALYTICS_TOKEN is not set on the dashboard' },
      { status: 503, headers: noStore },
    );
  }
  try {
    return NextResponse.json(await run(m), { headers: noStore });
  } catch (e) {
    if (e instanceof MarketError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers: noStore });
    }
    const message = e instanceof Error ? e.message : String(e);
    console.error('[market]', message);
    return NextResponse.json({ error: 'market_failed', message }, { status: 500, headers: noStore });
  }
}
