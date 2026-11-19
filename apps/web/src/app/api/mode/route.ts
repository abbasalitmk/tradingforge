import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const COOKIE_NAME = 'tf_trading_mode';

export async function GET() {
  const cookieStore = await cookies();
  const stored = cookieStore.get(COOKIE_NAME)?.value;
  const mode = (stored === 'LIVE' || stored === 'PAPER') ? stored : (process.env.TF_MODE ?? 'PAPER');
  return NextResponse.json({ mode }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { mode?: string };
    const target = (body.mode ?? '').toUpperCase();
    if (target !== 'LIVE' && target !== 'PAPER') {
      return NextResponse.json({ error: 'invalid_mode', message: 'Mode must be PAPER or LIVE' }, { status: 400 });
    }

    const cookieStore = await cookies();
    cookieStore.set(COOKIE_NAME, target, {
      path: '/',
      maxAge: 30 * 86400, // 30 days
      sameSite: 'lax',
      httpOnly: false,
    });

    return NextResponse.json({ ok: true, mode: target }, { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'failed', message }, { status: 500 });
  }
}
