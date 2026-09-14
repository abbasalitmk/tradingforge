import { z } from 'zod';

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ status: z.string(), data }).passthrough();

export const ltpQuote = z.object({
  last_price: z.number(),
  instrument_token: z.string(),
  ltq: z.number().optional(),
  volume: z.number().optional(),
  cp: z.number().optional(),
});
export const ltpResponse = envelope(z.record(z.string(), ltpQuote));

/** Upstox returns candles as positional arrays: [ts, o, h, l, c, volume, oi]. */
export const candleTuple = z.tuple([
  z.string(), z.number(), z.number(), z.number(), z.number(), z.number(), z.number(),
]);
export const candlesResponse = envelope(z.object({ candles: z.array(candleTuple) }));

export const instrumentSearchItem = z.object({
  name: z.string(),
  segment: z.string(),
  exchange: z.string(),
  isin: z.string().nullable().optional(),
  instrument_key: z.string(),
  trading_symbol: z.string().optional(),
  exchange_token: z.string().optional(),
  lot_size: z.number().optional(),
  tick_size: z.number().optional(),
}).passthrough();
export const instrumentSearchResponse = envelope(z.array(instrumentSearchItem));

export const fundsResponse = envelope(
  z.object({
    equity: z.object({
      available_margin: z.number().optional(),
      used_margin: z.number().optional(),
      payin_amount: z.number().optional(),
    }).passthrough().optional(),
  }).passthrough(),
);

export const placeOrderResponse = envelope(
  z.object({ order_ids: z.array(z.string()).optional(), order_id: z.string().optional() }).passthrough(),
);

export const gttPlaceResponse = envelope(
  z.object({ gtt_order_ids: z.array(z.string()).optional() }).passthrough(),
);

export const wsAuthorizeResponse = envelope(
  z.object({ authorized_redirect_uri: z.string().optional(), authorizedRedirectUri: z.string().optional() }).passthrough(),
);

export const orderBookResponse = envelope(z.array(z.record(z.string(), z.unknown())));

export type LtpQuote = z.infer<typeof ltpQuote>;
export type CandleTuple = z.infer<typeof candleTuple>;
export type InstrumentSearchItem = z.infer<typeof instrumentSearchItem>;
