import { type Clock, istMinutes, SESSION } from '@tradeforger/core';
import { verifyChain, type Sql } from '@tradeforger/db';
import type { UpstoxClient } from '@tradeforger/upstox';

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
  /** A soft check records a warning; a hard failure forces PAPER. */
  readonly hard: boolean;
}

export interface PreflightResult {
  readonly passed: boolean;
  readonly checks: readonly Check[];
}

/**
 * Runs at 09:00 IST and before any arm into LIVE.
 *
 * The point is to fail at 09:00 with a clear message rather than at 09:15 with
 * a rejected order. Any HARD failure forces the mode down to PAPER — the system
 * never proceeds into live trading on a partially-verified footing.
 */
export async function preflight(
  sql: Sql,
  client: UpstoxClient,
  clock: Clock,
  opts: { requireTrading: boolean },
): Promise<PreflightResult> {
  const checks: Check[] = [];
  const add = (name: string, passed: boolean, detail: string, hard = true): void => {
    checks.push({ name, passed, detail, hard });
  };

  // Audit chain must be intact before we trust anything it says.
  try {
    const chain = await verifyChain(sql);
    add('audit_chain', chain.ok,
      chain.ok ? `${chain.checked} entries verified` : `broken at seq ${chain.brokenAt}`);
  } catch (e) {
    add('audit_chain', false, e instanceof Error ? e.message : String(e));
  }

  // Data plane: market data must be reachable or there is nothing to trade on.
  const ltp = await client.ltp(['NSE_EQ|INE002A01018']);
  add('market_data', ltp.ok,
    ltp.ok ? `RELIANCE ₹${Object.values(ltp.value)[0]?.last_price ?? '?'}` : ltp.error.message);

  if (opts.requireTrading) {
    // Trading plane. A UDAPI1221 here means the static IP is not allowlisted,
    // and EVERY order would fail the same way.
    const funds = await client.funds();
    add('funds', funds.ok, funds.ok ? 'reachable'
      : `${funds.error.kind}${funds.error.kind === 'STATIC_IP_REQUIRED' ? ' — allowlist this host IP' : ''}`);

    const book = await client.orderBook();
    add('order_book', book.ok, book.ok ? 'reachable' : book.error.message);
  }

  const mins = istMinutes(clock.now());
  add('market_hours', mins >= SESSION.OPEN && mins < SESSION.CLOSE,
    `IST ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`, false);

  add('maintenance_window', !(mins >= SESSION.MAINTENANCE_START && mins < SESSION.MAINTENANCE_END),
    'Upstox funds API is down 00:00–05:30 IST');

  return { passed: checks.every((c) => c.passed || !c.hard), checks };
}
