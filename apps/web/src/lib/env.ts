import { z } from 'zod';

/**
 * Fail-closed environment validation.
 *
 * The web app is the *control plane only*. It deliberately has no Upstox
 * credentials beyond what OAuth requires, and never holds an access token —
 * the token exchange happens on the engine, behind the static-IP allowlist.
 */
const schema = z.object({
  TF_MODE: z.enum(['PAPER', 'SANDBOX', 'LIVE_ARMED', 'LIVE']).default('PAPER'),

  UPSTOX_API_KEY: z.string().min(10),
  UPSTOX_REDIRECT_URI: z.string().url(),

  /** High-entropy secret embedded in webhook paths. Upstox cannot sign its
   *  webhooks, so an unguessable URL is the only auth primitive available. */
  TF_WEBHOOK_SECRET: z.string().length(64, 'expected 64 hex chars (openssl rand -hex 32)'),

  /** Engine reached over a Cloudflare Tunnel. Never a public origin. */
  TF_ENGINE_URL: z.string().url(),
  TF_ENGINE_TOKEN: z.string().min(32),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Never echo values — only which keys failed.
    const keys = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${keys}`);
  }
  cached = parsed.data;
  return cached;
}
