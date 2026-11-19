import { NextResponse, type NextRequest } from 'next/server';

/**
 * Dashboard HTTP Basic auth (Next.js 16 `proxy` convention — formerly
 * `middleware`). Runs before every matched request.
 *
 *   - Exempt: /api/webhooks/* (path secret), /api/health, Next assets, favicon.
 *   - Creds configured  → required (constant-time compare), else 401.
 *   - Creds missing     → allowed in development; 503 in production (fail
 *                         closed — this app controls real money).
 *   - Half-configured   → 503 everywhere.
 *
 * Reads process.env directly so this file stays dependency-free.
 */

const REALM = 'TradeForger';

function isExempt(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/') ||
    pathname === '/favicon.ico' ||
    pathname.startsWith('/api/webhooks/') ||
    pathname === '/api/health' ||
    pathname === '/api/health/'
  );
}

function plain(status: number, message: string, extra?: Record<string, string>): NextResponse {
  return new NextResponse(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function unauthorized(): NextResponse {
  return plain(401, 'Authentication required', {
    'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
  });
}

function decodeBasic(header: string | null): { user: string; pass: string } | null {
  if (!header) return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return null;
  try {
    const bin = atob(match[1]);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const idx = decoded.indexOf(':');
    if (idx < 0) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** Constant-time equality: hashing first removes any length signal. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha[i]! ^ hb[i]!;
  return diff === 0;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (isExempt(request.nextUrl.pathname)) return NextResponse.next();

  const user = process.env.TF_DASHBOARD_USER ?? '';
  const pass = process.env.TF_DASHBOARD_PASSWORD ?? '';

  if (user === '' && pass === '') {
    if (process.env.NODE_ENV !== 'production') return NextResponse.next();
    return plain(503, 'dashboard auth not configured');
  }
  if (user === '' || pass === '') {
    return plain(503, 'dashboard auth not configured (set both TF_DASHBOARD_USER and TF_DASHBOARD_PASSWORD)');
  }

  const creds = decodeBasic(request.headers.get('authorization'));
  if (!creds) return unauthorized();

  // Evaluate both comparisons unconditionally (no short-circuit on username).
  const [userOk, passOk] = await Promise.all([safeEqual(creds.user, user), safeEqual(creds.pass, pass)]);
  if (!(userOk && passOk)) return unauthorized();

  return NextResponse.next();
}

export const config = {
  // Static assets never reach the proxy; webhooks/health are exempted in code.
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico).*)'],
};
