import { z } from 'zod';
import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

const num = z.number().finite().optional();
const body = z.object({
  category: z.string().min(1).max(40),
  filters: z.object({
    minPrice: num, maxPrice: num, minVolume: num, minTurnoverCr: num,
    minChangePct: num, maxChangePct: num, minAtrPct: num, maxAtrPct: num, minRvol: num,
    side: z.enum(['BUY', 'SELL', 'ANY']).optional(),
    style: z.enum(['INTRADAY', 'SWING', 'ANY']).optional(),
    minQuality: num, minRewardRisk: num,
    strategies: z.array(z.string().max(40)).max(30).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }).default({}),
});

/** Scan an index or the whole market with every selected strategy. Never places an order. */
export async function POST(req: Request) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  return respond(async (m) => {
    if (!parsed.success) throw new MarketError(400, 'bad_request', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return m.scan(parsed.data);
  });
}
