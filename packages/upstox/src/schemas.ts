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

// ─────────────────────────────── derivatives ───────────────────────────────

const num = z.number().nullable().optional();

export const optionMarketData = z.object({
  ltp: num, volume: num, oi: num, close_price: num,
  bid_price: num, bid_qty: num, ask_price: num, ask_qty: num, prev_oi: num,
}).passthrough();

export const optionGreeks = z.object({
  vega: num, theta: num, gamma: num, delta: num, iv: num, pop: num,
}).passthrough();

export const optionLeg = z.object({
  instrument_key: z.string(),
  market_data: optionMarketData.optional(),
  option_greeks: optionGreeks.optional(),
}).passthrough();

export const optionStrike = z.object({
  expiry: z.string(),
  pcr: num,
  strike_price: z.number(),
  underlying_key: z.string(),
  underlying_spot_price: z.number(),
  call_options: optionLeg.optional(),
  put_options: optionLeg.optional(),
}).passthrough();
export const optionChainResponse = envelope(z.array(optionStrike));

export const marginResponse = envelope(z.object({
  required_margin: z.number().optional(),
  final_margin: z.number().optional(),
}).passthrough());

/** One leg of a GTT as reported by GET /v3/order/gtt and the portfolio stream. */
export const gttRule = z.object({
  strategy: z.string(),
  status: z.string().optional(),
  message: z.string().optional(),
  trigger_type: z.string().optional(),
  trigger_price: z.number().optional(),
  transaction_type: z.string().optional(),
  order_id: z.string().nullable().optional(),
  trailing_gap: z.number().nullable().optional(),
}).passthrough();

export const gttDetail = z.object({
  gtt_order_id: z.string(),
  type: z.string().optional(),
  quantity: z.number().optional(),
  product: z.string().optional(),
  instrument_token: z.string().optional(),
  rules: z.array(gttRule).default([]),
}).passthrough();
export const gttDetailResponse = envelope(z.array(gttDetail));

export const orderBookEntry = z.object({
  order_id: z.string(),
  status: z.string(),
  instrument_token: z.string().optional(),
  transaction_type: z.string().optional(),
  product: z.string().optional(),
  quantity: z.number().optional(),
  filled_quantity: z.number().optional(),
  average_price: z.number().nullable().optional(),
  tag: z.string().nullable().optional(),
  status_message: z.string().nullable().optional(),
  order_timestamp: z.string().nullable().optional(),
}).passthrough();
export const orderBookEntries = envelope(z.array(orderBookEntry));

export const positionEntry = z.object({
  instrument_token: z.string(),
  product: z.string().optional(),
  quantity: z.number(),
  average_price: z.number().nullable().optional(),
  last_price: z.number().nullable().optional(),
}).passthrough();
export const positionsResponse = envelope(z.array(positionEntry));

export type OptionStrike = z.infer<typeof optionStrike>;
export type OptionLeg = z.infer<typeof optionLeg>;
export type GttRule = z.infer<typeof gttRule>;
export type GttDetail = z.infer<typeof gttDetail>;
export type OrderBookEntry = z.infer<typeof orderBookEntry>;
export type PositionEntry = z.infer<typeof positionEntry>;

/** GET /v2/market-quote/quotes — one entry per instrument, keyed by "SEGMENT:SYMBOL". */
// Indices carry no volume (Upstox sends null), and thinly traded or suspended
// instruments can lack other fields; only the LTP is required.
export const fullQuote = z.object({
  instrument_token: z.string(),
  symbol: z.string().optional(),
  last_price: z.number(),
  volume: z.number().nullable().optional(),
  average_price: z.number().nullable().optional(),
  net_change: z.number().nullable().optional(),
  ohlc: z.object({
    open: z.number().nullable(), high: z.number().nullable(), low: z.number().nullable(), close: z.number().nullable(),
  }).partial().nullable().optional(),
}).passthrough();
export const fullQuoteResponse = envelope(z.record(z.string(), fullQuote));
/** The envelope alone, so each instrument can be validated on its own. */
export const quoteEnvelope = envelope(z.record(z.string(), z.unknown()));
export type FullQuote = z.infer<typeof fullQuote>;
