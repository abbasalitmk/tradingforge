import { env } from './env';

export type RelayResult =
  | { ok: true; status: number }
  | { ok: false; reason: 'unreachable' | 'rejected'; status?: number };

/**
 * Relay an event to the trading engine.
 *
 * The engine lives behind a Cloudflare Tunnel on a static-IP host; this web app
 * is stateless and holds no Upstox token. Relay failures are NOT retried here —
 * a Vercel function must not block, and more importantly the engine already
 * reconciles from the authoritative order book on its own schedule. A dropped
 * hint costs latency, never correctness.
 */
export async function relayToEngine(path: string, body: unknown): Promise<RelayResult> {
  const { TF_ENGINE_URL, TF_ENGINE_TOKEN } = env();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const res = await fetch(new URL(path, TF_ENGINE_URL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TF_ENGINE_TOKEN}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, reason: 'rejected', status: res.status };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
