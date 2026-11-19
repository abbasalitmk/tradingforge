-- Research loop: strategy versions with their validation evidence, and the
-- per-trade memory that feeds evaluation. See docs/05-RESEARCH-LOOP.md.

-- One row per (strategy, parameter set). Status lifecycle:
--   CANDIDATE  → untested
--   VALIDATED  → passed every automated check; awaits a HUMAN approval
--   REJECTED   → failed at least one check
--   APPROVED   → human-approved; the only status LIVE trading may use
--   RETIRED    → superseded or withdrawn
-- Validation can never set APPROVED: the system does not approve itself.
CREATE TABLE IF NOT EXISTS strategy_versions (
  id            TEXT PRIMARY KEY,
  strategy_id   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  params        JSONB NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('CANDIDATE','VALIDATED','REJECTED','APPROVED','RETIRED')),
  origin        TEXT NOT NULL CHECK (origin IN ('DEFAULT','AI_PROPOSAL','MANUAL')),
  hypothesis    TEXT,
  validation    JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at  TIMESTAMPTZ,
  approved_at   TIMESTAMPTZ,
  approved_by   TEXT,
  UNIQUE (strategy_id, version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_versions_strategy ON strategy_versions (strategy_id, version DESC);

-- At most one APPROVED version per strategy: approving a new one retires the old.
CREATE UNIQUE INDEX IF NOT EXISTS idx_strategy_versions_one_approved
  ON strategy_versions (strategy_id) WHERE status = 'APPROVED';

-- Trade memory: not just whether a trade won, but why it was taken, how it was
-- executed and how it behaved while open.
CREATE TABLE IF NOT EXISTS trade_log (
  position_id     TEXT PRIMARY KEY,
  strategy_id     TEXT,
  strategy_version TEXT,
  mode            TEXT NOT NULL,
  segment         TEXT NOT NULL CHECK (segment IN ('EQ','FO')),
  style           TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  instrument_key  TEXT NOT NULL,
  side            TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity        INTEGER NOT NULL,
  entry_time      TIMESTAMPTZ,
  entry_price     NUMERIC(14,4),
  planned_entry   NUMERIC(14,4) NOT NULL,
  stop_loss       NUMERIC(14,4) NOT NULL,
  target          NUMERIC(14,4) NOT NULL,
  exit_time       TIMESTAMPTZ,
  exit_price      NUMERIC(14,4),
  exit_reason     TEXT,
  slippage        NUMERIC(14,4),
  charges         NUMERIC(14,4),
  gross_pnl       NUMERIC(14,4),
  net_pnl         NUMERIC(14,4),
  r_multiple      NUMERIC(10,4),
  mae_r           NUMERIC(10,4),
  mfe_r           NUMERIC(10,4),
  quality         INTEGER,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trade_log_strategy ON trade_log (strategy_id, exit_time DESC);
CREATE INDEX IF NOT EXISTS idx_trade_log_exit ON trade_log (exit_time DESC);
