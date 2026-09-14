import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Clock } from '@tradeforger/core';

/**
 * Order update from the portfolio stream.
 *
 * This is the AUTHORITATIVE fill source. Unlike the webhook path, this arrives
 * over a connection we opened and authenticated with our own bearer token, so
 * it is trustworthy in a way an unauthenticated POST is not.
 */
export const orderUpdate = z.object({
  update_type: z.literal('order').optional(),
  order_id: z.string(),
  status: z.string(),
  instrument_token: z.string().optional(),
  instrument_key: z.string().optional(),
  tag: z.string().optional(),
  filled_quantity: z.coerce.number().optional(),
  quantity: z.coerce.number().optional(),
  average_price: z.coerce.number().optional(),
  transaction_type: z.string().optional(),
  order_type: z.string().optional(),
  status_message: z.string().optional(),
}).passthrough();

export const gttUpdate = z.object({
  update_type: z.literal('gtt_order'),
  gtt_order_id: z.string(),
  status: z.string().optional(),
  instrument_token: z.string().optional(),
}).passthrough();

export type OrderUpdate = z.infer<typeof orderUpdate>;
export type GttUpdate = z.infer<typeof gttUpdate>;

/** Terminal order states — nothing further will arrive for these. */
export const TERMINAL_STATUSES = new Set(['complete', 'rejected', 'cancelled']);

/**
 * Upstox portfolio stream — order, GTT, position and holding updates as JSON.
 *
 * Requesting all four update types explicitly: the default is order-only, and
 * GTT updates are what tell us a bracket leg fired.
 */
export class PortfolioFeed extends EventEmitter {
  private ws: WebSocket | null = null;
  private closing = false;
  private reconnects = 0;
  private readonly getUrl: () => Promise<string>;
  private readonly clock: Clock;

  constructor(getUrl: () => Promise<string>, clock: Clock) {
    super();
    this.getUrl = getUrl;
    this.clock = clock;
  }

  async connect(): Promise<void> {
    this.closing = false;
    const url = await this.getUrl();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnects = 0;
      this.emit('open');
    });

    ws.on('message', (data: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return; // heartbeat or non-JSON frame
      }
      this.route(parsed);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null;
      this.emit('close', code, reason.toString());
      if (!this.closing) void this.scheduleReconnect();
    });

    ws.on('error', (e: Error) => this.emit('error', e));
  }

  private route(raw: unknown): void {
    const gtt = gttUpdate.safeParse(raw);
    if (gtt.success) {
      this.emit('gtt', gtt.data);
      return;
    }
    const order = orderUpdate.safeParse(raw);
    if (order.success) {
      this.emit('order', order.data);
      if (TERMINAL_STATUSES.has(order.data.status.toLowerCase())) {
        this.emit('terminal', order.data);
      }
      return;
    }
    this.emit('unknown', raw);
  }

  private async scheduleReconnect(): Promise<void> {
    this.reconnects += 1;
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
}
