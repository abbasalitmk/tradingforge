import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { FixedClock } from '@tradeforger/core';

const created: MockWs[] = [];

class MockWs extends EventEmitter {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = MockWs.OPEN;
  binaryType = 'nodebuffer';
  terminated = false;
  sent: Buffer[] = [];
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    created.push(this);
  }
  send(data: Buffer): void {
    this.sent.push(data);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = MockWs.CLOSED;
  }
  close(): void {
    this.readyState = MockWs.CLOSED;
  }
}

vi.mock('ws', () => ({ default: MockWs }));

describe('MarketFeed connection lifecycle', () => {
  it('tears down superseded WebSockets cleanly without zombie leaks', async () => {
    const { MarketFeed } = await import('./market.ts');
    created.length = 0;

    let seq = 0;
    let resolveFirst!: (u: string) => void;
    const getUrl = () => {
      seq++;
      if (seq === 1) return new Promise<string>((r) => { resolveFirst = r; });
      return Promise.resolve(`wss://mock/${seq}`);
    };

    const clock = new FixedClock(new Date('2026-11-25T05:00:00Z'));
    let opens = 0;
    let closes = 0;
    const feed = new MarketFeed(getUrl, clock);
    feed.on('open', () => { opens++; });
    feed.on('close', () => { closes++; });

    // Start first connect (in flight waiting on URL), then supersede via reconnect()
    const p1 = feed.connect();
    const p2 = feed.reconnect();
    resolveFirst('wss://mock/1');
    await Promise.all([p1, p2]);

    // Only the newer socket should be constructed and active
    expect(created).toHaveLength(1);
    const activeWs = created[0]!;
    expect(activeWs.url).toBe('wss://mock/2');

    activeWs.emit('open');
    expect(feed.isConnected).toBe(true);
    expect(opens).toBe(1);

    // Calling reconnect again terminates activeWs before opening the new socket
    await feed.reconnect();
    expect(activeWs.terminated).toBe(true);
    expect(created).toHaveLength(2);
    expect(closes).toBe(0);

    created[1]!.emit('open');
    expect(opens).toBe(2);

    feed.close();
    expect(created[1]!.terminated).toBe(true);
    expect(feed.isConnected).toBe(false);
  });
});
