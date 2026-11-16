import { z } from 'zod';

const schema = z.object({
  TF_MODE: z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']).default('PAPER'),

  UPSTOX_API_KEY: z.string().min(10).default('b08b0b88-0e9b-4f44-894f-a68d17d20465'),
  UPSTOX_REDIRECT_URI: z.string().url().default('http://localhost:3000/api/auth/callback'),

  TF_WEBHOOK_SECRET: z.string().min(32).default('9ed50257864e86e587ce90ddd87d615966f81e553120d79b8e19657a7fd89457'),
  TF_ENGINE_URL: z.string().url().default('http://127.0.0.1:4000'),
  TF_ENGINE_TOKEN: z.string().min(32).default('3f12ecde83de8626901893e42201ccfa4f1ea578e4675ac3751e4f25ed5fdf9d'),
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
  };

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}
