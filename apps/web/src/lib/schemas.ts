import { z } from 'zod';

/**
 * Upstox webhook payloads.
 *
 * SECURITY: Upstox webhooks carry no signature, HMAC or IP allowlist — the
 * documentation explicitly states they "should not require authentication".
 * Anything arriving here is therefore ATTACKER-CONTROLLED until proven
 * otherwise, and is treated strictly as a *hint* that something may have
 * changed. It never mutates position state. The engine reacts by re-polling
 * the authoritative Upstox endpoints with its own credentials.
 *
 * Schemas are permissive on unknown fields (Upstox adds them over time) but
 * strict on the identifiers we act upon.
 */

export const orderUpdate = z
  .object({
    update_type: z.literal('order'),
    order_id: z.string().min(1),
    status: z.string().min(1),
    instrument_key: z.string().optional(),
    tag: z.string().optional(),
    filled_quantity: z.coerce.number().optional(),
    average_price: z.coerce.number().optional(),
  })
  .passthrough();

export const gttUpdate = z
  .object({
    update_type: z.literal('gtt_order'),
    gtt_order_id: z.string().min(1),
    status: z.string().optional(),
    instrument_key: z.string().optional(),
  })
  .passthrough();

export const webhookPayload = z.union([orderUpdate, gttUpdate]);
export type WebhookPayload = z.infer<typeof webhookPayload>;

/** Upstox notifier postback for the semi-automated daily token flow. */
export const tokenNotification = z
  .object({
    client_id: z.string().optional(),
    user_id: z.string().optional(),
    access_token: z.string().min(20).optional(),
    message_type: z.string().optional(),
  })
  .passthrough();
