import { respond, MarketError } from '@/lib/market';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

/** Each strategy's backtest record on one stock. */
export function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol') ?? '';
  return respond(async (m) => {
    if (!symbol) throw new MarketError(400, 'bad_request', 'symbol is required');
    return m.stockEdge(symbol);
  });
}
