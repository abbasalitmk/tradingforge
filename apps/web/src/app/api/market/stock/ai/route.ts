import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

/** AI consensus on the stock's best current setup. */
export function GET(req: Request) {
  const u = new URL(req.url);
  const symbol = u.searchParams.get('symbol') ?? '';
  const strategies = u.searchParams.get('strategies')?.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
  return respond(async (m) => {
    if (!symbol) throw new MarketError(400, 'bad_request', 'symbol is required');
    return m.stockAi(symbol, strategies);
  });
}
