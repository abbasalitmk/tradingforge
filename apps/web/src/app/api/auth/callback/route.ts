import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { relayToEngine } from '@/lib/engine';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Upstox OAuth redirect target.
 *
 * The authorization code is relayed to the engine, which performs the
 * code→token exchange itself. That is not an arbitrary split: the exchange
 * requires the API secret, and the resulting token is only usable from the
 * account's allowlisted static IP (UDAPI1221). Exchanging here would put the
 * secret on Vercel and mint a token bound to an IP Vercel does not have.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return NextResponse.redirect(new URL(`/?auth=error&reason=${encodeURIComponent(error)}`, url.origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/?auth=error&reason=missing_code', url.origin));
  }

  const relay = await relayToEngine('/auth/exchange', {
    code,
    state,
    redirectUri: env().UPSTOX_REDIRECT_URI,
  });

  return NextResponse.redirect(
    new URL(relay.ok ? '/?auth=ok' : '/?auth=engine_unreachable', url.origin),
  );
}
