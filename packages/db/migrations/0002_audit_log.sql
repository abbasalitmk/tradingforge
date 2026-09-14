-- Append-only, hash-chained audit log.
--
-- Two properties are enforced at the DATABASE level rather than in application
-- code, because the whole point of an audit log is that it stays true even when
-- the application is wrong or compromised:
--
--   1. Rows cannot be updated or deleted (triggers below).
--   2. Each row's hash covers the previous row's hash, so removing or altering
--      any row breaks the chain and is detectable by verify_audit_chain().

CREATE TABLE IF NOT EXISTS audit_log (
  seq         BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,          -- engine | user | webhook | watchdog
  mode        TEXT NOT NULL,
  position_id TEXT,
  signal_id   TEXT,
  payload     JSONB NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_at       ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_kind     ON audit_log (kind, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_position ON audit_log (position_id) WHERE position_id IS NOT NULL;

-- Compute the chain hash server-side. Doing this in the database rather than in
-- the engine means a compromised engine cannot forge a consistent chain without
-- also holding a database connection that can bypass the triggers below.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER AS $$
DECLARE
  last_hash TEXT;
BEGIN
  SELECT hash INTO last_hash FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := COALESCE(last_hash, repeat('0', 64));
  NEW.hash := encode(
    sha256(
      convert_to(
        NEW.prev_hash ||
        COALESCE(NEW.at::text, '') || NEW.kind || NEW.actor || NEW.mode ||
        COALESCE(NEW.position_id, '') || COALESCE(NEW.signal_id, '') ||
        NEW.payload::text,
        'UTF8'
      )
    ),
    'hex'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_chain ON audit_log;
CREATE TRIGGER trg_audit_log_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

-- Refuse mutation outright.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update ON audit_log;
CREATE TRIGGER trg_audit_log_no_update
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Walk the chain and report the first row whose hash does not reproduce.
CREATE OR REPLACE FUNCTION verify_audit_chain()
RETURNS TABLE(ok BOOLEAN, checked BIGINT, broken_at BIGINT) AS $$
DECLARE
  r          RECORD;
  expected   TEXT := repeat('0', 64);
  recomputed TEXT;
  n          BIGINT := 0;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq ASC LOOP
    recomputed := encode(
      sha256(
        convert_to(
          expected ||
          COALESCE(r.at::text, '') || r.kind || r.actor || r.mode ||
          COALESCE(r.position_id, '') || COALESCE(r.signal_id, '') ||
          r.payload::text,
          'UTF8'
        )
      ),
      'hex'
    );
    n := n + 1;
    IF r.prev_hash <> expected OR r.hash <> recomputed THEN
      RETURN QUERY SELECT FALSE, n, r.seq;
      RETURN;
    END IF;
    expected := r.hash;
  END LOOP;
  RETURN QUERY SELECT TRUE, n, NULL::BIGINT;
END;
$$ LANGUAGE plpgsql;
