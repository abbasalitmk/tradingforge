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
 * secret on the public web tier and mint a token bound to an IP it may not have.
 */
function getPublicOrigin(req: Request): string {
  try {
    const configured = env().UPSTOX_REDIRECT_URI;
    if (configured) {
      const u = new URL(configured);
      if (u.protocol && u.host && !u.host.startsWith('0.0.0.0')) {
        return u.origin;
      }
    }
  } catch {
    // ignore
  }

  const forwardedHost = req.headers.get('x-forwarded-host') || req.headers.get('host');
  if (forwardedHost && !forwardedHost.startsWith('0.0.0.0')) {
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    return `${proto}://${forwardedHost}`;
  }

  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const origin = getPublicOrigin(req);

  if (error) {
    return NextResponse.redirect(new URL(`/?auth=error&reason=${encodeURIComponent(error)}`, origin));
  }
  if (!code) {
    return NextResponse.redirect(new URL('/?auth=error&reason=missing_code', origin));
  }

  const relay = await relayToEngine('/auth/exchange', {
    code,
    state,
    redirectUri: env().UPSTOX_REDIRECT_URI,
  });

  return NextResponse.redirect(
    new URL(relay.ok ? '/?auth=ok' : '/?auth=engine_unreachable', origin),
  );
}
