import { respond } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** Watchlist quotes and the ranked universe. Works without the engine. */
export function GET() {
  return respond((m) => m.overview());
}
