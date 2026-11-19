import { z } from 'zod';
import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const body = z.object({
  symbol: z.string().min(1).max(32),
  style: z.enum(['INTRADAY', 'SWING']).default('INTRADAY'),
});

/** Deep analysis of one stock with the AI consensus. Never places an order. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  return respond(async (m) => {
    if (!parsed.success) throw new MarketError(400, 'bad_request', 'expected {symbol, style}');
    return m.analyzeStock(parsed.data.symbol, parsed.data.style);
  });
}
