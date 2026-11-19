import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const strategiesOf = (u: URL): string[] | undefined =>
  u.searchParams.get('strategies')?.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);

/** Realtime analysis of one stock: every strategy's vote, the best setups and indicators. */
export function GET(req: Request) {
  const u = new URL(req.url);
  const symbol = u.searchParams.get('symbol') ?? '';
  return respond(async (m) => {
    if (!symbol) throw new MarketError(400, 'bad_request', 'symbol is required');
    return m.stock(symbol, strategiesOf(u));
  });
}
