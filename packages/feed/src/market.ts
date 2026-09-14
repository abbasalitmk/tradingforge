import { EventEmitter } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import WebSocket from 'ws';
import type { Tick, Clock } from '@tradeforger/core';

export type FeedMode = 'ltpc' | 'full' | 'option_greeks' | 'full_d30';

/**
 * Standard-tier subscription ceilings. Exceeding them silently degrades the
 * feed rather than erroring, so the manager enforces them client-side.
 */
export const INSTRUMENT_LIMITS: Record<FeedMode, number> = {
  ltpc: 5000,
  option_greeks: 3000,
  full: 2000,
  full_d30: 0, // Upstox Plus only
};

/**
 * Standard tier allows 2 WebSocket connections per user TOTAL. The engine needs
 * one for market data and one for the portfolio feed — that is both of them.
 * Nothing else in the system may open one.
 */
export const MAX_CONNECTIONS = 2;

interface Decoded {
  type?: string;
  feeds?: Record<string, {
    ltpc?: { ltp?: number; ltt?: string | number; ltq?: string | number; cp?: number };
    fullFeed?: {
      marketFF?: {
        ltpc?: { ltp?: number; ltq?: string | number; cp?: number };
        vtt?: string | number;
        atp?: number;
      };
      indexFF?: { ltpc?: { ltp?: number; ltq?: string | number; cp?: number } };
    };
  }>;
  currentTs?: string | number;
}

export interface MarketFeedEvents {
  tick: (t: Tick) => void;
  status: (s: string) => void;
  open: () => void;
  close: (code: number, reason: string) => void;
  error: (e: Error) => void;
}

/**
 * Upstox V3 market data feed.
 *
 * Two things this gets right that the previous stockwatch implementation did
 * not: it actually decodes the protobuf (the old one called JSON.parse on a
 * binary frame, so it never worked), and it sends subscription messages as
 * BINARY frames, which Upstox requires — a text frame is silently ignored.
 */
export class MarketFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private root: protobuf.Root | null = null;
  private responseType: protobuf.Type | null = null;
  private readonly subscriptions = new Map<string, FeedMode>();
  private reconnects = 0;
  private closing = false;
  private readonly clock: Clock;
  private readonly getUrl: () => Promise<string>;
  private lastTickMs: number | null = null;

  constructor(getUrl: () => Promise<string>, clock: Clock) {
    super();
    this.getUrl = getUrl;
    this.clock = clock;
  }

  /** Milliseconds since the last tick — the feed-staleness breaker reads this. */
  staleness(): number | null {
    return this.lastTickMs === null ? null : this.clock.ms() - this.lastTickMs;
  }

  private loadProto(): protobuf.Type {
    if (this.responseType) return this.responseType;
    const file = join(dirname(fileURLToPath(import.meta.url)), 'MarketDataFeedV3.proto');
    // loadSync, not parse(readFileSync(...)): the schema imports
    // google/protobuf/wrappers.proto, and only the loader resolves protobufjs's
    // bundled common types. Parsing the raw string fails on DoubleValue.
    this.root = protobuf.loadSync(file);
    this.responseType = this.root.lookupType(
      'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
    );
    return this.responseType;
  }

  async connect(): Promise<void> {
    this.closing = false;
    const type = this.loadProto();
    const url = await this.getUrl();

    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    this.ws = ws;

    ws.on('open', () => {
      this.reconnects = 0;
      this.emit('open');
      if (this.subscriptions.size > 0) this.resubscribe();
    });

    ws.on('message', (data: Buffer) => {
      try {
        const decoded = type.decode(data);
        const obj = type.toObject(decoded, { longs: String, defaults: true }) as Decoded;
        this.handle(obj);
      } catch (e) {
        this.emit('error', e instanceof Error ? e : new Error(String(e)));
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null;
      this.emit('close', code, reason.toString());
      if (!this.closing) void this.scheduleReconnect();
    });

    ws.on('error', (e: Error) => this.emit('error', e));
  }

  private handle(msg: Decoded): void {
    if (msg.type && msg.type !== 'live_feed' && msg.type !== 'initial_feed') {
      this.emit('status', msg.type);
    }
    const ts = msg.currentTs ? Number(msg.currentTs) : this.clock.ms();

    for (const [instrumentKey, feed] of Object.entries(msg.feeds ?? {})) {
      const ltpc = feed.ltpc
        ?? feed.fullFeed?.marketFF?.ltpc
        ?? feed.fullFeed?.indexFF?.ltpc;
      if (!ltpc?.ltp) continue;

      const tick: Tick = {
        instrumentKey,
        ltp: ltpc.ltp,
        ...(ltpc.ltq !== undefined ? { ltq: Number(ltpc.ltq) } : {}),
        ...(feed.fullFeed?.marketFF?.vtt !== undefined
          ? { volume: Number(feed.fullFeed.marketFF.vtt) }
          : {}),
        ...(ltpc.cp !== undefined ? { close: ltpc.cp } : {}),
        ts,
      };
      this.lastTickMs = this.clock.ms();
      this.emit('tick', tick);
    }
  }

  /** Subscription messages MUST be binary; Upstox ignores text frames. */
  private send(method: 'sub' | 'unsub' | 'change_mode', mode: FeedMode, keys: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload = {
      guid: `tf-${this.clock.ms()}`,
      method,
      data: { mode, instrumentKeys: keys },
    };
    this.ws.send(Buffer.from(JSON.stringify(payload)));
  }

  subscribe(keys: readonly string[], mode: FeedMode = 'full'): { accepted: string[]; rejected: string[] } {
    const limit = INSTRUMENT_LIMITS[mode];
    const current = [...this.subscriptions.values()].filter((m) => m === mode).length;
    const room = Math.max(0, limit - current);

    const accepted = keys.slice(0, room);
    const rejected = keys.slice(room);

    for (const k of accepted) this.subscriptions.set(k, mode);
    if (accepted.length > 0) this.send('sub', mode, [...accepted]);
    return { accepted: [...accepted], rejected: [...rejected] };
  }

  /** Unsubscribe aggressively as the watchlist rotates — the instrument budget
   *  is the binding constraint on how wide the scanner can look. */
  unsubscribe(keys: readonly string[]): void {
    const byMode = new Map<FeedMode, string[]>();
    for (const k of keys) {
      const mode = this.subscriptions.get(k);
      if (!mode) continue;
      this.subscriptions.delete(k);
      const list = byMode.get(mode) ?? [];
      list.push(k);
      byMode.set(mode, list);
    }
    for (const [mode, list] of byMode) this.send('unsub', mode, list);
  }

  private resubscribe(): void {
    const byMode = new Map<FeedMode, string[]>();
    for (const [key, mode] of this.subscriptions) {
      const list = byMode.get(mode) ?? [];
      list.push(key);
      byMode.set(mode, list);
    }
    for (const [mode, keys] of byMode) this.send('sub', mode, keys);
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnects += 1;
    // Cap at 30s. An unbounded backoff during market hours is worse than
    // hammering: a feed that reconnects at minute 40 has missed the session.
    const delay = Math.min(1000 * 2 ** this.reconnects, 30_000);
    await new Promise((r) => setTimeout(r, delay));
    if (this.closing) return;
    try {
      await this.connect();
    } catch (e) {
      this.emit('error', e instanceof Error ? e : new Error(String(e)));
      void this.scheduleReconnect();
    }
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }

  get subscribedCount(): number {
    return this.subscriptions.size;
  }
}
