/** Live protobuf decode test against the V3 market feed. Read-only. */
import { SystemClock } from '../packages/core/src/index.ts';
import { TokenStore, UpstoxClient } from '../packages/upstox/src/index.ts';
import { MarketFeed } from '../packages/feed/src/market.ts';

const analytics = process.env.UPSTOX_ANALYTICS_TOKEN;
if (!analytics) { console.error('UPSTOX_ANALYTICS_TOKEN not set'); process.exit(1); }

const tokens = new TokenStore(SystemClock, { analyticsToken: analytics });
const client = new UpstoxClient(tokens, { timeoutMs: 15_000 });

const feed = new MarketFeed(async () => {
  const r = await client.marketFeedUrl();
  if (!r.ok) throw new Error(`authorize failed: ${r.error.message}`);
  return r.value;
}, SystemClock);

let ticks = 0;
const seen = new Map<string, number>();

feed.on('open', () => {
  console.log('✓ connected');
  const keys = ['NSE_EQ|INE002A01018', 'NSE_EQ|INE467B01029', 'NSE_INDEX|Nifty 50'];
  const { accepted, rejected } = feed.subscribe(keys, 'full');
  console.log(`  subscribed ${accepted.length}, rejected ${rejected.length}`);
});
feed.on('status', (s) => console.log(`  status: ${s}`));
feed.on('tick', (t) => { ticks++; seen.set(t.instrumentKey, t.ltp); });
feed.on('error', (e) => console.log(`  error: ${e.message}`));
feed.on('close', (c, r) => console.log(`  closed ${c} ${r}`));

await feed.connect();
await new Promise((r) => setTimeout(r, 12_000));

console.log(`\n✓ decoded ${ticks} ticks from ${seen.size} instruments`);
for (const [k, ltp] of seen) console.log(`  ${k.padEnd(24)} ₹${ltp}`);
console.log(`  staleness: ${feed.staleness()}ms`);
feed.close();
process.exit(0);
