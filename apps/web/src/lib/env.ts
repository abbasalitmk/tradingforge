import { z } from 'zod';

const schema = z.object({
  TF_MODE: z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']).default('PAPER'),

  // Secrets have no defaults: they must come from the environment, never source.
  UPSTOX_API_KEY: z.string().min(10),
  UPSTOX_REDIRECT_URI: z.string().url().default('http://localhost:3000/api/auth/callback'),

  TF_WEBHOOK_SECRET: z.string().min(32),
  TF_ENGINE_URL: z.string().url().default('http://127.0.0.1:4000'),
  TF_ENGINE_TOKEN: z.string().min(32),

  // HTTP Basic auth for the dashboard. Enforced in src/proxy.ts, which reads
  // process.env directly (it runs before routing and must stay dependency-light).
  // Listed here for documentation; a half-configured pair fails closed there.
  TF_DASHBOARD_USER: z.string().min(1).optional(),
  TF_DASHBOARD_PASSWORD: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const raw = {
    TF_MODE: process.env['TF_MODE'],
    UPSTOX_API_KEY: process.env['UPSTOX_API_KEY'] || process.env['UPSTOCK_API_KEY'],
    UPSTOX_REDIRECT_URI: process.env['UPSTOX_REDIRECT_URI'],
    TF_WEBHOOK_SECRET: process.env['TF_WEBHOOK_SECRET'],
    TF_ENGINE_URL: process.env['TF_ENGINE_URL'],
    TF_ENGINE_TOKEN: process.env['TF_ENGINE_TOKEN'],
    TF_DASHBOARD_USER: process.env['TF_DASHBOARD_USER'] || undefined,
    TF_DASHBOARD_PASSWORD: process.env['TF_DASHBOARD_PASSWORD'] || undefined,
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}
