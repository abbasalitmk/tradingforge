import { respond } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Find an NSE stock by symbol or name. */
export function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q') ?? '';
  return respond((m) => m.search(q.slice(0, 40)));
}
