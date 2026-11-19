import { respond } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Scan categories and the strategy catalog. */
export function GET() {
  return respond(async (m) => m.catalog());
}
