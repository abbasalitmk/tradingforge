# Upstox API Reference — extracted 2026-09-14

Source: `https://api.upstox.com/v2/api-docs` (OpenAPI 3.1.0) — mirrored at `upstox-openapi-v2.json`.
Live base: `https://api.upstox.com` · HFT order host: `https://api-hft.upstox.com`

## Endpoints used by TradeForger

| Method | Path | Plane | Notes |
|---|---|---|---|
| POST | /v2/login/authorization/token | auth | daily token, expires 03:30 IST |
| POST | /v3/login/auth/token/request/{client_id} | auth | notifier-webhook re-auth |
| GET/PUT | /v2/user/ip | auth | **static IP allowlist — required for trading plane** |
| GET | /v2/user/profile | trading | static IP |
| GET | /v3/user/get-funds-and-margin | trading | static IP · 423 during 00:00–05:30 IST |
| GET/POST | /v2/user/kill-switch | trading | segments: NSE_EQ, BSE_EQ, NSE_FO, … · ENABLE/DISABLE |
| POST | /v3/order/place | trading | qty, product I/D, validity DAY/IOC, order_type MARKET/LIMIT/SL/SL-M, tag, slice |
| PUT | /v3/order/modify | trading | order_id, order_type, price, trigger_price, validity |
| DELETE | /v3/order/cancel | trading | ?order_id= |
| POST | /v3/order/gtt/place | trading | **type MULTIPLE = native OCO bracket** |
| PUT | /v3/order/gtt/modify | trading | gtt_order_id + rules |
| DELETE | /v3/order/gtt/cancel | trading | |
| GET | /v3/order/gtt | trading | ?gtt_order_id= (omit for all) |
| GET | /v2/order/retrieve-all | trading | order book — reconciliation source |
| GET | /v2/order/details, /v2/order/history | trading | |
| GET | /v2/order/trades/get-trades-for-day | trading | |
| POST | /v2/order/positions/exit | trading | wired to hard kill switch |
| GET | /v2/portfolio/short-term-positions | trading | |
| GET | /v2/portfolio/long-term-holdings | trading | |
| GET | /v3/portfolio/mtf-positions | trading | |
| PUT | /v2/portfolio/convert-position | trading | intraday → delivery |
| POST | /v2/charges/margin | trading | pre-trade margin check |
| GET | /v2/charges/brokerage | trading | **cost model for backtests** |
| GET | /v2/trade/profit-loss/data | trading | journal reconciliation |
| GET | /v2/instruments/search | data | query, exchanges, segments, instrument_types, expiry, atm_offset, page_number, records |
| GET | /v3/market-quote/ltp | data | ≤500 instrument_key, comma-sep |
| GET | /v3/market-quote/ohlc | data | |
| GET | /v3/market-quote/quotes | data | ≤500, full snapshot |
| GET | /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from} | data | see interval matrix |
| GET | /v3/historical-candle/intraday/{key}/{unit}/{interval} | data | current day |
| GET | /v2/market/holidays[/{date}] | data | boot + 09:00 check |
| GET | /v2/market/status/{exchange} | data | |
| GET | /v2/market/timings/{date} | data | |
| GET | /v3/feed/market-data-feed/authorize | data | → wss, protobuf |
| GET | /v2/feed/portfolio-stream-feed/authorize | trading | → wss, **JSON** order/position/holding/gtt |
| GET | /v2/news | data | optional AI context |
| GET | /v2/fundamentals/{isin}/key-ratios | data | optional swing filter |
| GET | /v2/market/fii, /v2/market/dii | data | optional sentiment |

## Rate limits

| Category | /sec | /min | /30min |
|---|---|---|---|
| Order placement — Regular Algo (unregistered) | 10 | 500 | 2000 |
| Order placement — SEBI-Registered Algo | 50 | 500 | 2000 |
| Standard APIs (funds, positions, candles, quotes) | 50 | 500 | 2000 |

Enforced per-API, per-user. TradeForger uses **one shared token bucket** across
place/modify/cancel/multi/GTT at Regular Algo limits.

## Historical candle V3 — unit/interval matrix

| Unit | Intervals | History from | Max span per request |
|---|---|---|---|
| minutes | 1–300 | Jan 2022 | 1 month (≤15m) · 1 quarter (>15m) |
| hours | 1–5 | Jan 2022 | 1 quarter |
| days | 1 | Jan 2000 | 1 decade |
| weeks | 1 | Jan 2000 | unlimited |
| months | 1 | Jan 2000 | unlimited |

## Market Data Feed V3 (protobuf)

- Authorize → `wss://wsfeeder-api.upstox.com/market-data-feeder/v3/...`
- Modes: `ltpc`, `option_greeks`, `full` (5-level depth), `full_d30` (30-level, Plus only)
- Standard limits: **2 connections/user**; 5000 `ltpc` / 3000 greeks / 2000 `full` instruments
- Messages sent as **binary**: `{guid, method: sub|unsub|change_mode, data:{mode, instrumentKeys}}`
- Decode with official `MarketDataFeed.proto`

## Portfolio Stream Feed (JSON)

- `wss://api.upstox.com/v2/feed/portfolio-stream-feed?update_types=order,gtt_order,position,holding`
- JSON payloads with `update_type`; order updates carry `order_id`, `status`, `filled_quantity`, `average_price`
- **Authoritative fill source.** No public webhook endpoint required.

## GTT MULTIPLE — native bracket

```json
POST /v3/order/gtt/place
{
  "type": "MULTIPLE",
  "quantity": 10,
  "product": "I",
  "instrument_token": "NSE_EQ|INE002A01018",
  "transaction_type": "BUY",
  "rules": [
    { "strategy": "ENTRY",    "trigger_type": "ABOVE",     "trigger_price": 1260.0 },
    { "strategy": "TARGET",   "trigger_type": "IMMEDIATE", "trigger_price": 1285.0 },
    { "strategy": "STOPLOSS", "trigger_type": "IMMEDIATE", "trigger_price": 1248.0,
      "trailing_gap": 5.0, "market_protection": -1 }
  ]
}
```

- ENTRY is mandatory; each strategy usable once. TARGET/STOPLOSS accept `IMMEDIATE` only.
- `trailing_gap` (STOPLOSS only) min = 10% of |LTP − SL trigger|.
- `market_protection`: -1 auto · 0 none · 1–25 percent.
- Products: `I`, `D`, `MTF`.

## Sandbox

Covers **7 endpoints only**: place/modify/cancel order (v2 + v3) and place multi-order.
Separate 30-day token from the Developer Apps page; one sandbox app per user.
No market data, funds, positions, GTT or historical data ⇒ **cannot host the strategy loop**.

## Error codes seen

| Code | Meaning |
|---|---|
| UDAPI1221 | Endpoint requires request from the account's configured static IP |
| UDAPI100016 | Invalid credentials / expired token |
| HTTP 423 | Funds API locked, 00:00–05:30 IST maintenance |
