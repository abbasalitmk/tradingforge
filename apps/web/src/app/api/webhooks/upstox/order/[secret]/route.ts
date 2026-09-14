import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { secretMatches } from '@/lib/secret';
import { webhookPayload } from '@/lib/schemas';
import { relayToEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Upstox order / GTT update webhook.
 *
 * Upstox sends these unauthenticated, so the 64-hex path segment is the only
 * thing separating a genuine callback from an anonymous POST. Two consequences
 * are baked in below:
 *
 *   1. A bad secret returns 404, not 401 — an unauthenticated endpoint should
 *      not confirm to a prober that the path shape is meaningful.
 *   2. The payload is relayed as an untrusted HINT. The engine re-polls
 *      /v2/order/retrieve-all and /v3/order/gtt with its own credentials before
 *      touching position state. A forged fill therefore costs one wasted poll,
 *      not a phantom position.
 *
 * We always answer 200 on a valid secret, even when the relay fails. Upstox's
 * retry semantics are undocumented, and the engine reconciles on its own timer
 * regardless — so a non-200 buys nothing and risks unknown retry behaviour.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ secret: string }> },
) {
  const { secret } = await ctx.params;

  if (!secretMatches(secret, env().TF_WEBHOOK_SECRET)) {
    return new NextResponse('Not Found', { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ accepted: false, reason: 'malformed' }, { status: 400 });
  }

  const parsed = webhookPayload.safeParse(raw);
  if (!parsed.success) {
    // Unknown shape: acknowledge so Upstox stops retrying, but do not relay.
    console.warn('[webhook:order] unrecognised payload shape');
    return NextResponse.json({ accepted: true, relayed: false, reason: 'unrecognised' });
  }

  const relay = await relayToEngine('/hooks/order', {
    source: 'upstox-webhook',
    trusted: false,
    receivedAt: new Date().toISOString(),
    payload: parsed.data,
  });

  return NextResponse.json({ accepted: true, relayed: relay.ok });
}

/** Upstox may probe the URL on save. Answer without revealing the secret's validity. */
export async function GET(_req: Request, ctx: { params: Promise<{ secret: string }> }) {
  const { secret } = await ctx.params;
  if (!secretMatches(secret, env().TF_WEBHOOK_SECRET)) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return NextResponse.json({ ok: true, endpoint: 'upstox-order-webhook' });
}
