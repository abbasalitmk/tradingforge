import { z } from 'zod';
import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const body = z.object({ symbol: z.string().min(1).max(32) });

/** An options setup, sized at one lot for reference. Never places an order. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  return respond(async (m) => {
    if (!parsed.success) throw new MarketError(400, 'bad_request', 'expected {symbol}');
    return m.analyzeFno(parsed.data.symbol);
  });
}
