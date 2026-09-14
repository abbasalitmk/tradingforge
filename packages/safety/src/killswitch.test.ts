import { describe, it, expect, vi } from 'vitest';
import { fire, type KillActions } from './killswitch.ts';

/** The audit write is the only DB touch; stub it so these stay pure unit tests. */
const sqlStub = Object.assign(
  () => Promise.resolve([]),
  { json: (v: unknown) => v },
) as never;

function actions(over: Partial<KillActions> = {}): KillActions {
  return {
    stopNewEntries: vi.fn(async () => {}),
    cancelAllOpenOrders: vi.fn(async () => 2),
    cancelAllGtt: vi.fn(async () => 1),
    exitAllPositions: vi.fn(async () => 3),
    disableSegment: vi.fn(async () => {}),
    ...over,
  };
}

describe('SOFT', () => {
  it('stops entries but leaves open positions alone', async () => {
    const a = actions();
    const r = await fire('SOFT', a, sqlStub, 'PAPER');
    expect(a.stopNewEntries).toHaveBeenCalledOnce();
    expect(a.exitAllPositions).not.toHaveBeenCalled();
    expect(a.disableSegment).not.toHaveBeenCalled();
    expect(r.positionsExited).toBe(0);
  });
});

describe('HARD', () => {
  it('cancels orders and GTTs then flattens, without touching the segment', async () => {
    const a = actions();
    const r = await fire('HARD', a, sqlStub, 'LIVE');
    expect(a.cancelAllOpenOrders).toHaveBeenCalledOnce();
    expect(a.cancelAllGtt).toHaveBeenCalledOnce();
    expect(a.exitAllPositions).toHaveBeenCalledOnce();
    expect(a.disableSegment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ordersCancelled: 2, gttCancelled: 1, positionsExited: 3 });
    expect(r.errors).toHaveLength(0);
  });
});

describe('NUCLEAR', () => {
  it('does everything HARD does, then disables the segment at Upstox', async () => {
    const a = actions();
    const r = await fire('NUCLEAR', a, sqlStub, 'LIVE');
    expect(a.disableSegment).toHaveBeenCalledWith('NSE_EQ');
    expect(r.segmentDisabled).toBe(true);
  });
});

describe('partial failure', () => {
  it('still flattens positions when cancelling GTTs throws', async () => {
    const a = actions({
      cancelAllGtt: vi.fn(async () => { throw new Error('upstox 500'); }),
    });
    const r = await fire('HARD', a, sqlStub, 'LIVE');

    // The critical assertion: an earlier failure must not abort the emergency.
    expect(a.exitAllPositions).toHaveBeenCalledOnce();
    expect(r.positionsExited).toBe(3);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('cancelAllGtt');
  });

  it('records every failure without throwing', async () => {
    const boom = async (): Promise<never> => { throw new Error('down'); };
    const a = actions({
      stopNewEntries: vi.fn(boom),
      cancelAllOpenOrders: vi.fn(boom),
      cancelAllGtt: vi.fn(boom),
      exitAllPositions: vi.fn(boom),
      disableSegment: vi.fn(boom),
    });
    const r = await fire('NUCLEAR', a, sqlStub, 'LIVE');
    expect(r.errors).toHaveLength(5);
    expect(r.segmentDisabled).toBe(false);
  });
});
