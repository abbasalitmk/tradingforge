import { NextResponse, type NextRequest } from 'next/server';
import { env } from '../../../../lib/env';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Thin, honest pass-through to the trading engine.
 *
 * Invariants (this app controls real money):
 *   - Never fabricates data. If the engine cannot be reached, the caller gets
 *     503 {error:'engine_offline', offline:true} — never a 2xx.
 *   - The engine's status code and JSON body are passed through unchanged,
 *     including 4xx/5xx, so the UI can surface the real error.
 *   - Only whitelisted subpaths are forwarded; everything else is 404.
 */

const GET_PATHS = new Set(['/state', '/health', '/auth/status', '/fno/chain', '/analysis/live', '/auto/config', '/watchlist', '/memory/trades', '/research/strategies']);

const POST_PATHS = new Set([
  '/auto/fno',
  '/research/validate',
  '/research/approve',
  '/research/propose',
  '/research/retire',
  '/auto/config',
  '/watchlist/add',
  '/watchlist/remove',
  '/positions/resolve',
  '/strategy/autotrade',
  '/strategy/target',
  '/strategy/filters',
  '/strategy/mode',
  '/sizing',
  '/scanner/analyze',
  '/kill',
  '/positions/exit',
  '/fno/toggle',
  '/fno/analyze',
  '/mode/arm',
  '/mode/disarm',
  '/mode/switch',
  '/mode/set',
  '/halt/reset',
]);

const GET_TIMEOUT_MS = 3_000;
// The kill switch cancels orders / GTTs and may flatten positions; give it room.
const POST_TIMEOUT_MS = 10_000;
// A HARD/NUCLEAR kill against Upstox cancels GTTs, exits and re-syncs. Timing
// out mid-kill would report failure for a kill that is still executing.
const KILL_TIMEOUT_MS = 30_000;

const NO_STORE = { 'cache-control': 'no-store, max-age=0' };

type RouteCtx = { params: Promise<{ path: string[] }> };

function jsonResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function offline(): NextResponse {
  return jsonResponse({ error: 'engine_offline', offline: true }, 503);
}

async function forward(
  req: NextRequest,
  ctx: RouteCtx,
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  const { path } = await ctx.params;
  const subpath = '/' + path.join('/');
  const allowed = method === 'GET' ? GET_PATHS : POST_PATHS;
  if (!allowed.has(subpath)) {
    return jsonResponse({ error: 'not_found' }, 404);
  }

  let engineUrl: string;
  let engineToken: string;
  try {
    const cfg = env();
    engineUrl = cfg.TF_ENGINE_URL;
    engineToken = cfg.TF_ENGINE_TOKEN;
  } catch (e) {
    console.error('[proxy] environment misconfigured:', e instanceof Error ? e.message : e);
    return jsonResponse({ error: 'web_misconfigured' }, 500);
  }

  let body: string | undefined;
  if (method === 'POST') {
    const raw = await req.text();
    if (raw.trim() === '') {
      body = '{}';
    } else {
      try {
        body = JSON.stringify(JSON.parse(raw));
      } catch {
        return jsonResponse({ error: 'invalid_json_body' }, 400);
      }
    }
  }

  const target = `${engineUrl.replace(/\/+$/, '')}${subpath}${req.nextUrl.search}`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    method === 'GET' ? GET_TIMEOUT_MS : subpath === '/kill' ? KILL_TIMEOUT_MS : POST_TIMEOUT_MS,
  );

  let status: number;
  let text: string;
  try {
    const res = await fetch(target, {
      method,
      headers: {
        authorization: `Bearer ${engineToken}`,
        accept: 'application/json',
        ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
      },
      body,
      cache: 'no-store',
      signal: controller.signal,
    });
    status = res.status;
    text = await res.text();
  } catch {
    // Connection refused, DNS failure, tunnel down, or timeout.
    return offline();
  } finally {
    clearTimeout(timer);
  }

  if (status === 204 || status === 205 || status === 304) {
    return new NextResponse(null, { status, headers: NO_STORE });
  }

  if (text.trim() === '') {
    return jsonResponse({}, status);
  }

  try {
    return jsonResponse(JSON.parse(text), status);
  } catch {
    // Non-JSON from the engine (e.g. a tunnel/proxy error page). Never let it
    // masquerade as success.
    return jsonResponse(
      { error: 'engine_non_json_response', engineStatus: status, body: text.slice(0, 500) },
      status >= 400 ? status : 502,
    );
  }
}

export function GET(req: NextRequest, ctx: RouteCtx) {
  return forward(req, ctx, 'GET');
}

export function POST(req: NextRequest, ctx: RouteCtx) {
  return forward(req, ctx, 'POST');
}
