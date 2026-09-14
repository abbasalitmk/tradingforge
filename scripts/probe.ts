/**
 * Live smoke test of the data plane against real Upstox endpoints.
 * Read-only: quotes, candles, instrument search, feed authorize. Places nothing.
 */
import { SystemClock } from '../packages/core/src/index.ts';
import { TokenStore, UpstoxClient } from '../packages/upstox/src/index.ts';

const analytics = process.env.UPSTOX_ANALYTICS_TOKEN;
if (!analytics) { console.error('UPSTOX_ANALYTICS_TOKEN not set'); process.exit(1); }

const tokens = new TokenStore(SystemClock, { analyticsToken: analytics });
const client = new UpstoxClient(tokens, { timeoutMs: 15_000 });

const RELIANCE = 'NSE_EQ|INE002A01018';
const TCS = 'NSE_EQ|INE467B01029';

console.log('── data plane ──────────────────────────────────');

const ltp = await client.ltp([RELIANCE, TCS]);
if (ltp.ok) {
  for (const [k, q] of Object.entries(ltp.value)) {
    console.log(`  LTP  ${k.padEnd(22)} ₹${q.last_price}  vol=${q.volume ?? '—'}`);
  }
} else {
  console.log(`  LTP  FAILED ${ltp.error.kind}: ${ltp.error.message}`);
}

const daily = await client.historicalCandles(RELIANCE, 'days', 1, '2026-09-12', '2026-08-12');
console.log(daily.ok
  ? `  CANDLES  ${daily.value.length} daily bars; latest close ₹${daily.value[0]?.close}`
  : `  CANDLES  FAILED ${daily.error.kind}: ${daily.error.message}`);

const intra = await client.intradayCandles(RELIANCE, 'minutes', 5);
console.log(intra.ok
  ? `  INTRADAY ${intra.value.length} 5-min bars today`
  : `  INTRADAY FAILED ${intra.error.kind}: ${intra.error.message}`);

const search = await client.searchInstruments('RELIANCE', { exchanges: 'NSE' });
console.log(search.ok
  ? `  SEARCH   ${search.value.length} hits; first = ${search.value[0]?.tradingSymbol} (${search.value[0]?.instrumentKey})`
  : `  SEARCH   FAILED ${search.error.kind}: ${search.error.message}`);

const feed = await client.marketFeedUrl();
console.log(feed.ok
  ? `  WS AUTH  ${feed.value.slice(0, 58)}…`
  : `  WS AUTH  FAILED ${feed.error.kind}: ${feed.error.message}`);

console.log('\n── trading plane (expected to fail: no static IP) ──');
const funds = await client.funds();
console.log(funds.ok
  ? '  FUNDS    ok'
  : `  FUNDS    ${funds.error.kind} (${funds.error.code ?? '—'}) halt=${funds.error.shouldHalt}`);

const book = await client.orderBook();
console.log(book.ok
  ? '  ORDERS   ok'
  : `  ORDERS   ${book.error.kind} (${book.error.code ?? '—'}) halt=${book.error.shouldHalt}`);

console.log('\n── rate limiter ────────────────────────────────');
const s = client.http.limiterStats();
console.log(`  standard: ${s.standard.lastSecond}/s  ${s.standard.lastMinute}/min`);
console.log(`  order:    ${s.order.lastSecond}/s  ${s.order.lastMinute}/min`);
