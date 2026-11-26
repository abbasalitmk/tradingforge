import { describe, it, expect } from 'vitest';
import { FixedClock, type Paise } from '@tradeforger/core';
import { PaperBroker, DEFAULT_PAPER_CONFIG } from '@tradeforger/broker';
import { PositionMachine } from '@tradeforger/execution';
import { Trader, type TradeIntent } from './trader.ts';

const P = (r: number) => Math.round(r * 100) as Paise;
const KEY = 'NSE_FO|50978';
// 10:00 IST
const at = (hhmm: string) => new Date(`2026-11-18T${hhmm}:00+05:30`);

function setup(time = '10:00') {
  const clock = new FixedClock(at(time));
  const broker = new PaperBroker(clock, { ...DEFAULT_PAPER_CONFIG, latencyMs: 0, slippageBps: 0 });
  const transitions: string[] = [];
  const machine = new PositionMachine(async (_p, from, to) => { transitions.push(`${from}>${to}`); });
  const trader = new Trader({ clock, broker, machine, perTradeLossPaise: () => P(100_000), log: () => {} });
  const tick = (ltp: number) => broker.onTick({ instrumentKey: KEY, ltp, ts: clock.ms() });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { clock, broker, trader, transitions, tick, settle };
}

const intent = (over: Partial<TradeIntent> = {}): TradeIntent => ({
  segment: 'FO', style: 'INTRADAY', signalId: 'sig_x', instrumentKey: KEY, symbol: 'NIFTY',
  side: 'BUY', quantity: 65, product: 'I', entry: P(100), stopLoss: P(70), target: P(160),
  trailingGap: null, costPaise: P(6_500), timeStopMin: null,
  contract: { tradingSymbol: 'NIFTY 25000 CE', instrumentType: 'CE', strike: 25000, expiry: '2026-11-24', lotSize: 65, lots: 1 },
  ...over,
});

describe('position lifecycle is driven by broker events', () => {
  it('walks entry → managing → target → closed and books the P&L', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());
    expect(r.ok).toBe(true);
    await s.settle();
    const p = r.ok ? r.position : null;
    expect(p?.state).toBe('MANAGING');
    expect(p?.avgEntry).toBe(P(100));

    s.tick(161);
    await s.settle();
    expect(p?.state).toBe('CLOSED');
    expect(p?.exitReason).toBe('TARGET');
    expect(s.trader.realisedPnl).toBe(P(60) * 65);
    expect(s.trader.consecutiveLosses).toBe(0);
    expect(s.transitions).toEqual([
      'CANDIDATE>AI_REVIEWED', 'AI_REVIEWED>RISK_APPROVED', 'RISK_APPROVED>ENTRY_SENT',
      'ENTRY_SENT>ENTRY_ACKED', 'ENTRY_ACKED>ENTRY_FILLED', 'ENTRY_FILLED>BRACKET_ARMED',
      'BRACKET_ARMED>MANAGING', 'MANAGING>EXIT_TRIGGERED', 'EXIT_TRIGGERED>EXIT_FILLED', 'EXIT_FILLED>CLOSED',
    ]);
  });

  it('counts a stop-out as a loss so the consecutive-loss breaker can see it', async () => {
    const s = setup();
    s.tick(100);
    await s.trader.open(intent());
    await s.settle();
    s.tick(65);
    await s.settle();
    expect(s.trader.realisedPnl).toBe(-P(35) * 65);
    expect(s.trader.consecutiveLosses).toBe(1);
    expect(s.trader.live()).toHaveLength(0);
  });

  it('refuses a second position in the same instrument', async () => {
    const s = setup();
    s.tick(100);
    await s.trader.open(intent());
    const second = await s.trader.open(intent());
    expect(second.ok).toBe(false);
  });

  it('records a broker rejection as REJECTED and counts it', async () => {
    const s = setup();
    // No tick: the paper broker refuses to invent a price (BLOCKED, not REJECTED).
    const r = await s.trader.open(intent());
    expect(r.ok).toBe(false);
    expect([...s.trader.positions.values()][0]!.state).toBe('REJECTED');
  });
});

describe('per-position broker routing', () => {
  it('keeps an open position on the broker that opened it when entries switch brokers', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());
    await s.settle();
    expect(r.ok && r.position.broker).toBe('PAPER');

    // Entries now go to a second broker; the open position's exit must not.
    const other = new PaperBroker(s.clock, { ...DEFAULT_PAPER_CONFIG, latencyMs: 0 });
    s.trader.setBroker('UPSTOX', other);
    expect(s.trader.activeBroker).toBe('UPSTOX');
    s.tick(110);
    const x = await s.trader.exit(r.ok ? r.position.id : '', 'MANUAL');
    await s.settle();
    expect(x.ok).toBe(true);
    expect(r.ok && r.position.state).toBe('CLOSED');
    expect(other.inspect().orders).toBe(0);
  });

  it('does not double-apply events when a broker is re-selected', async () => {
    const s = setup();
    s.trader.setBroker('PAPER', s.broker);
    s.trader.setBroker('PAPER', s.broker);
    s.tick(100);
    await s.trader.open(intent());
    await s.settle();
    s.tick(161);
    await s.settle();
    expect(s.trader.realisedPnl).toBe(P(60) * 65);
  });
});

describe('loss streak', () => {
  it('counts strategy exits but not operator exits', async () => {
    const s = setup();
    s.tick(100);
    const a = await s.trader.open(intent());
    await s.settle();
    s.tick(65); // stop-loss
    await s.settle();
    expect(s.trader.consecutiveLosses).toBe(1);

    s.tick(100);
    const b = await s.trader.open(intent());
    await s.settle();
    s.tick(90);
    await s.trader.exit(b.ok ? b.position.id : '', 'MANUAL');
    await s.settle();
    expect(b.ok && b.position.realisedPnl! < 0).toBe(true);
    expect(s.trader.consecutiveLosses).toBe(1);
    expect(a.ok).toBe(true);
  });
});

describe('journal and recovery', () => {
  it('sends no order when the journal cannot record the intent', async () => {
    const clock = new FixedClock(at('10:00'));
    const broker = new PaperBroker(clock, { ...DEFAULT_PAPER_CONFIG, latencyMs: 0 });
    const machine = new PositionMachine(async (_p, _from, to) => {
      if (to === 'ENTRY_SENT') throw new Error('database unreachable');
    });
    const trader = new Trader({ clock, broker, machine, perTradeLossPaise: () => P(100_000), log: () => {} });
    broker.onTick({ instrumentKey: KEY, ltp: 100, ts: clock.ms() });
    const r = await trader.open(intent());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain('journal');
    expect(broker.inspect().activeBrackets).toBe(0);
    expect(trader.positions.size).toBe(0);
  });

  it('keeps paper practice out of LIVE: P&L, loss streak, orders, holdings and capital are per broker', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());          // paper entry
    await s.settle();
    s.tick(65);                                        // paper stop-out
    await s.settle();
    expect(r.ok && r.position.state).toBe('CLOSED');
    expect(s.trader.consecutiveLosses).toBe(1);
    const open = await s.trader.open(intent({ instrumentKey: 'NSE_EQ|P2', symbol: 'P2' }));
    expect(open.ok).toBe(false);                       // no price for P2 on paper: fine, still counted as an order
    // Switch to the live broker (a second paper engine stands in for Upstox).
    const live = new PaperBroker(s.clock, { ...DEFAULT_PAPER_CONFIG, latencyMs: 0, slippageBps: 0 });
    s.trader.setBroker('UPSTOX', live);
    expect(s.trader.realisedPnl).toBe(P(0));
    expect(s.trader.consecutiveLosses).toBe(0);
    expect(s.trader.ordersToday).toBe(0);
    expect(s.trader.deployed()).toBe(P(0));
    // A paper position still open does not block or use up a LIVE slot in the same stock...
    s.trader.setBroker('PAPER', s.broker);
    s.tick(100);
    const held = await s.trader.open(intent());
    await s.settle();
    expect(held.ok && held.position.state).toBe('MANAGING');
    s.trader.setBroker('UPSTOX', live);
    expect(s.trader.holds(KEY)).toBe(false);
    expect(s.trader.live('UPSTOX')).toHaveLength(0);
    // ...but it is still managed: every position stays under the exit loop.
    expect(s.trader.live().some((p) => p.broker === 'PAPER')).toBe(true);
  });

  it('rebuilds each broker\'s day separately after a restart', () => {
    const s = setup('12:00');
    const closed = (pnl: number, hhmm: string, broker: 'PAPER' | 'UPSTOX') => ({
      state: 'CLOSED', realisedPnl: P(pnl), closedAt: at(hhmm).getTime(), openedAt: at('09:30').getTime(), broker,
    }) as unknown as Parameters<typeof s.trader.restoreDay>[0][number];
    s.trader.restoreDay([closed(-300, '10:00', 'PAPER'), closed(-200, '10:30', 'PAPER'), closed(400, '11:00', 'UPSTOX')]);
    expect(s.trader.consecutiveLosses).toBe(2);        // active broker: PAPER
    s.trader.setBroker('UPSTOX', s.broker);
    expect(s.trader.realisedPnl).toBe(P(400));
    expect(s.trader.consecutiveLosses).toBe(0);
    expect(s.trader.ordersToday).toBe(2);
  });

  it('rebuilds today’s P&L and loss streak from the journal', () => {
    const s = setup('12:00');
    const closed = (pnl: number, hhmm: string) => ({
      state: 'CLOSED', realisedPnl: P(pnl), closedAt: at(hhmm).getTime(), openedAt: at('09:30').getTime(),
    }) as unknown as Parameters<typeof s.trader.restoreDay>[0][number];
    s.trader.restoreDay([closed(500, '10:00'), closed(-200, '10:30'), closed(-300, '11:00')]);
    expect(s.trader.realisedPnl).toBe(P(0));
    expect(s.trader.consecutiveLosses).toBe(2);
    expect(s.trader.ordersToday).toBe(6);
  });

  it('lets a human close or re-adopt an ORPHANED position, nothing else', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());
    await s.settle();
    const p = r.ok ? r.position : null;
    expect(await s.trader.resolveOrphan(p!.id, { kind: 'MANAGING', note: 'x' })).toMatchObject({ ok: false });

    p!.state = 'ORPHANED';
    const back = await s.trader.resolveOrphan(p!.id, { kind: 'MANAGING', note: 'bracket live at broker' });
    expect(back.ok).toBe(true);
    expect(p!.state).toBe('MANAGING');

    p!.state = 'ORPHANED';
    const shut = await s.trader.resolveOrphan(p!.id, { kind: 'CLOSED', exitPrice: P(90), note: 'stopped out at broker' });
    expect(shut.ok).toBe(true);
    expect(p!.state).toBe('CLOSED');
    expect(p!.realisedPnl).toBe(-P(10) * 65);
    expect(s.trader.realisedPnl).toBe(-P(10) * 65);
    // An operator's resolution is real P&L but not evidence the strategy is failing.
    expect(s.trader.consecutiveLosses).toBe(0);
  });
});

describe('exits outside the bracket', () => {
  it('manual exit cancels the bracket first, then fills at market', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());
    await s.settle();
    s.tick(110);
    const x = await s.trader.exit(r.ok ? r.position.id : '', 'MANUAL');
    await s.settle();
    expect(x.ok).toBe(true);
    const p = r.ok ? r.position : null;
    expect(p?.state).toBe('CLOSED');
    expect(p?.exitReason).toBe('MANUAL');
    expect(s.broker.inspect().activeBrackets).toBe(0);
  });

  it('does not send a second exit when a bracket leg already fired', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent());
    await s.settle();
    s.tick(161); // target fills
    await s.settle();
    const x = await s.trader.exit(r.ok ? r.position.id : '', 'MANUAL');
    expect(x.ok).toBe(false);
    const sells = (await s.broker.openOrders());
    expect(sells.ok && sells.value.filter((o) => o.side === 'SELL')).toHaveLength(1);
  });

  it('squares off intraday positions at 15:05 IST', async () => {
    const s = setup('14:50');
    s.tick(100);
    const r = await s.trader.open(intent());
    await s.settle();
    s.clock.set(at('15:04'));
    await s.trader.manage(() => 101);
    await s.settle();
    expect(r.ok && r.position.state).toBe('MANAGING');
    s.clock.set(at('15:05'));
    await s.trader.manage(() => 101);
    await s.settle();
    expect(r.ok && r.position.exitReason).toBe('EOD_SQUARE_OFF');
    expect(r.ok && r.position.state).toBe('CLOSED');
  });

  it('lets a position reach its own stop; the per-trade backstop only catches a failed one', async () => {
    // Planned risk 65 × ₹30 = ₹1,950, per-trade limit ₹1,000 (sized before the capital fell).
    const clock = new FixedClock(at('10:00'));
    const broker = new PaperBroker(clock, { ...DEFAULT_PAPER_CONFIG, latencyMs: 0, slippageBps: 0 });
    const machine = new PositionMachine(async () => {});
    const trader = new Trader({ clock, broker, machine, perTradeLossPaise: () => P(1_000), log: () => {} });
    broker.onTick({ instrumentKey: KEY, ltp: 100, ts: clock.ms() });
    const r = await trader.open(intent());
    await new Promise((res) => setTimeout(res, 0));
    await trader.manage(() => 75); // −₹1,625: past the limit, inside the planned risk
    expect(r.ok && r.position.state).toBe('MANAGING');
    await trader.manage(() => 65); // −₹2,275: past planned risk + 15% — the stop failed
    expect(r.ok && r.position.exitReason).toBe('PER_TRADE_LOSS');
  });

  it('cancels every unfilled entry at 15:00 IST, delivery included', async () => {
    const s = setup('14:58');
    s.tick(100);
    // Hold the entry unfilled, as a GTT waiting on its trigger would be.
    Object.assign(s.broker, { fillEntry: () => {} });
    const r = await s.trader.open(intent({ product: 'D', style: 'SWING' }));
    await s.settle();
    expect(r.ok && r.position.state).toBe('ENTRY_ACKED');
    await s.trader.manage(() => null);
    expect(r.ok && r.position.state).toBe('ENTRY_ACKED');
    s.clock.set(at('15:00'));
    await s.trader.manage(() => null);
    await s.settle();
    expect(r.ok && r.position.state).toBe('CANCELLED');
  });

  it('eodOnly still squares off at 15:05 but skips the discretionary exits', async () => {
    const s = setup('14:50');
    s.tick(100);
    const r = await s.trader.open(intent({ timeStopMin: 1 }));
    await s.settle();
    s.clock.set(at('15:03'));
    await s.trader.manage(() => 100, { eodOnly: true });
    expect(r.ok && r.position.state).toBe('MANAGING');
    s.clock.set(at('15:05'));
    await s.trader.manage(() => 100, { eodOnly: true });
    await s.settle();
    expect(r.ok && r.position.exitReason).toBe('EOD_SQUARE_OFF');
  });

  it('time-stops a flat option before theta eats it, but leaves a winner alone', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent({ timeStopMin: 20 }));
    await s.settle();
    s.clock.advance(21 * 60_000);
    await s.trader.manage(() => 120);
    expect(r.ok && r.position.state).toBe('MANAGING');
    s.tick(99);
    await s.trader.manage(() => 99);
    await s.settle();
    expect(r.ok && r.position.exitReason).toBe('TIME_STOP');
  });

  it('cuts a trade with no follow-through, but not one that moved and came back', async () => {
    const stall = { afterMin: 20, minMfeR: 0.25 }; // risk 30 → needs +7.5 within 20 min
    const s = setup();
    s.tick(100);
    const stuck = await s.trader.open(intent({ stall }));
    await s.settle();
    await s.trader.manage(() => 104);
    s.clock.advance(21 * 60_000);
    s.tick(99);
    await s.trader.manage(() => 99);
    await s.settle();
    expect(stuck.ok && stuck.position.exitReason).toBe('NO_FOLLOW_THROUGH');

    const t = setup();
    t.tick(100);
    const moved = await t.trader.open(intent({ stall }));
    await t.settle();
    await t.trader.manage(() => 110);
    t.clock.advance(21 * 60_000);
    await t.trader.manage(() => 99);
    expect(moved.ok && moved.position.state).toBe('MANAGING');
  });

  it('kill switch flattens every open position through the broker', async () => {
    const s = setup();
    s.tick(100);
    await s.trader.open(intent());
    await s.settle();
    await s.trader.flattenAll();
    await s.settle();
    expect(s.trader.live()).toHaveLength(0);
  });

  it('enforces staged cost-buffered breakeven trailing stop once MFE clears breakevenR', async () => {
    const s = setup();
    s.tick(100);
    const r = await s.trader.open(intent({
      entry: P(100), stopLoss: P(90), target: P(200),
      stagedTrail: { breakevenR: 1.2, breakevenLockR: 0.35, trailFromR: 1.6, trailGapPaise: P(5) },
    }));
    await s.settle();
    // Initial MFE < 1.2R -> virtual stop stays inactive
    await s.trader.manage(() => 110);
    expect(r.ok && r.position.virtualStopPaise).toBeNull();
    // MFE reaches +1.3R (>= 1.2R) -> locks +0.35R above entry (103.50)
    await s.trader.manage(() => 113);
    expect(r.ok && r.position.virtualStopPaise).toBe(P(103.5));
    // Reverse back to 103.00 -> exits cleanly via TRAILING_STOP above entry
    s.tick(103);
    await s.trader.manage(() => 103);
    await s.settle();
    expect(r.ok && r.position.state).toBe('CLOSED');
    expect(r.ok && r.position.exitReason).toBe('TRAILING_STOP');
  });
});
