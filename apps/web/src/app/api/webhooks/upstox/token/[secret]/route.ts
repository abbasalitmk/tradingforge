import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { secretMatches } from '@/lib/secret';
import { tokenNotification } from '@/lib/schemas';
import { relayToEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Upstox notifier postback for the semi-automated daily token flow
 * (POST /v3/login/auth/token/request/{client_id}).
 *
 * This endpoint can receive a LIVE ACCESS TOKEN, which makes it the most
 * sensitive surface in the whole control plane. Rules enforced here:
 *
 *   - The token is never logged, never persisted by the web app, and never
 *     returned in a response body.
 *   - It is forwarded straight to the engine over the tunnel and dropped.
 *   - Because the channel is unauthenticated, the engine treats an inbound
 *     token as a CANDIDATE: it validates it against /v2/user/profile before
 *     replacing the active token. An attacker who guesses the path can
 *     therefore submit a token, but not a working one.
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
    return NextResponse.json({ accepted: false }, { status: 400 });
  }

  const parsed = tokenNotification.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ accepted: true, relayed: false });
  }

  const relay = await relayToEngine('/hooks/token', {
    source: 'upstox-notifier',
    trusted: false,
    receivedAt: new Date().toISOString(),
    payload: parsed.data,
  });

  // Deliberately no detail in the response — this path must stay opaque.
  return NextResponse.json({ accepted: true, relayed: relay.ok });
}
