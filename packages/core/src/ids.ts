import { ulid } from 'ulid';

/**
 * ULIDs, not UUIDs: lexicographically sortable by creation time, which makes
 * the audit log naturally ordered and makes a position id readable as a
 * timestamp during incident review.
 */
export type PositionId = string & { readonly __brand: 'PositionId' };
export type SignalId = string & { readonly __brand: 'SignalId' };
export type OrderRef = string & { readonly __brand: 'OrderRef' };

export const newPositionId = (): PositionId => `pos_${ulid()}` as PositionId;
export const newSignalId = (): SignalId => `sig_${ulid()}` as SignalId;

/**
 * The `tag` sent to Upstox on every order.
 *
 * This is the idempotency key: it maps a broker order back to our position, so
 * a retry after a network blip is detectable rather than a second live order.
 * Upstox caps tag length at 40 chars — a 26-char ULID plus prefix fits.
 */
export const orderTag = (positionId: PositionId): string =>
  positionId.replace('pos_', 'tf').slice(0, 40);
