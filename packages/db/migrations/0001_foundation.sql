-- TradeForger foundation schema.
-- Money is stored as BIGINT paise throughout; see packages/core/src/money.ts.

CREATE TABLE IF NOT EXISTS instruments (
  instrument_key   TEXT PRIMARY KEY,
  trading_symbol   TEXT NOT NULL,
  name             TEXT NOT NULL,
  exchange         TEXT NOT NULL,
  segment          TEXT NOT NULL,
  isin             TEXT,
  lot_size         INTEGER NOT NULL DEFAULT 1,
  tick_size        NUMERIC(10,4) NOT NULL DEFAULT 0.05,
  is_fno           BOOLEAN NOT NULL DEFAULT FALSE,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instruments_symbol  ON instruments (trading_symbol);
CREATE INDEX IF NOT EXISTS idx_instruments_segment ON instruments (segment);

-- Candles. Composite PK makes the daily backfill naturally idempotent.
CREATE TABLE IF NOT EXISTS candles (
  instrument_key TEXT NOT NULL REFERENCES instruments(instrument_key) ON DELETE CASCADE,
  unit           TEXT NOT NULL,          -- minutes | hours | days | weeks | months
  interval_n     INTEGER NOT NULL,
  ts             TIMESTAMPTZ NOT NULL,
  open           NUMERIC(14,4) NOT NULL,
  high           NUMERIC(14,4) NOT NULL,
  low            NUMERIC(14,4) NOT NULL,
  close          NUMERIC(14,4) NOT NULL,
  volume         BIGINT NOT NULL DEFAULT 0,
  oi             BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (instrument_key, unit, interval_n, ts)
);
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles (instrument_key, unit, interval_n, ts DESC);

CREATE TABLE IF NOT EXISTS signals (
  id             TEXT PRIMARY KEY,
  instrument_key TEXT NOT NULL,
  symbol         TEXT NOT NULL,
  style          TEXT NOT NULL CHECK (style IN ('SCALP','INTRADAY','SWING')),
  side           TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  entry_paise      BIGINT NOT NULL,
  stop_loss_paise  BIGINT NOT NULL,
  target_paise     BIGINT NOT NULL,
  atr            NUMERIC(14,4) NOT NULL,
  confidence     INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
  indicators     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AI verdict is advisory and may only reduce risk; see docs/00-PLAN.md §6.5
  ai_verdict     TEXT CHECK (ai_verdict IN ('CONFIRM','REJECT','CAUTION')),
  ai_confidence  INTEGER CHECK (ai_confidence BETWEEN 0 AND 100),
  ai_flags       JSONB,
  ai_rationale   TEXT,
  ai_latency_ms  INTEGER,
  ai_model       TEXT,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_generated ON signals (generated_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id                TEXT PRIMARY KEY,
  signal_id         TEXT REFERENCES signals(id),
  instrument_key    TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  side              TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  style             TEXT NOT NULL,
  state             TEXT NOT NULL,
  mode              TEXT NOT NULL CHECK (mode IN ('PAPER','SANDBOX','LIVE_ARMED','LIVE')),
  sizing_mode       TEXT NOT NULL CHECK (sizing_mode IN ('FIXED_QTY','FIXED_BUDGET','RISK_BASED')),

  quantity          INTEGER NOT NULL,
  filled_quantity   INTEGER NOT NULL DEFAULT 0,
  entry_paise       BIGINT NOT NULL,
  avg_entry_paise   BIGINT,
  stop_loss_paise   BIGINT NOT NULL,
  target_paise      BIGINT NOT NULL,
  exit_paise        BIGINT,

  entry_order_id    TEXT,
  gtt_order_id      TEXT,
  exit_order_id     TEXT,
  broker_tag        TEXT NOT NULL,

  realised_pnl_paise   BIGINT,
  charges_paise        BIGINT,

  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_positions_state ON positions (state)
  WHERE state NOT IN ('CLOSED','REJECTED','CANCELLED');
CREATE INDEX IF NOT EXISTS idx_positions_opened ON positions (opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_tag ON positions (broker_tag);

-- At most one live position per instrument. Enforced by the database rather
-- than by engine logic, so a race between two decision paths cannot double-enter.
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_one_open_per_instrument
  ON positions (instrument_key)
  WHERE state NOT IN ('CLOSED','REJECTED','CANCELLED');

CREATE TABLE IF NOT EXISTS orders (
  id                BIGSERIAL PRIMARY KEY,
  position_id       TEXT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  broker_order_id   TEXT,
  kind              TEXT NOT NULL CHECK (kind IN ('ENTRY','EXIT','STOPLOSS','TARGET','GTT')),
  side              TEXT NOT NULL,
  order_type        TEXT NOT NULL,
  product           TEXT NOT NULL,
  validity          TEXT NOT NULL,
  quantity          INTEGER NOT NULL,
  price_paise       BIGINT NOT NULL,
  trigger_paise     BIGINT NOT NULL,
  status            TEXT NOT NULL,
  filled_quantity   INTEGER NOT NULL DEFAULT 0,
  avg_price_paise   BIGINT,
  mode              TEXT NOT NULL,
  request_payload   JSONB NOT NULL,
  response_payload  JSONB,
  placed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_position ON orders (position_id);
CREATE INDEX IF NOT EXISTS idx_orders_broker   ON orders (broker_order_id);

-- Daily risk counters. One row per IST trading date; the circuit breakers read
-- and write this, and it is the record that survives an engine restart.
CREATE TABLE IF NOT EXISTS risk_days (
  trade_date            DATE PRIMARY KEY,
  starting_capital_paise BIGINT NOT NULL,
  realised_pnl_paise    BIGINT NOT NULL DEFAULT 0,
  orders_placed         INTEGER NOT NULL DEFAULT 0,
  entries_taken         INTEGER NOT NULL DEFAULT 0,
  consecutive_losses    INTEGER NOT NULL DEFAULT 0,
  rejects               INTEGER NOT NULL DEFAULT 0,
  halted                BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason           TEXT,
  halted_at             TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS engine_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
