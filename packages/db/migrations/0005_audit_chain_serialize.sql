-- Serialise audit chain appends.
--
-- 0002's trigger read the latest hash without a lock, so two concurrent
-- inserts both chained onto the same predecessor and forked the chain
-- (observed 2026-11-18: two ENGINE_SHUTDOWN rows 62µs apart, both after seq 5).
-- The engine writes audit rows concurrently in normal operation, so this
-- would have recurred.
--
-- Fix: take a transaction-scoped advisory lock, THEN assign seq and read the
-- predecessor. seq must be assigned under the lock too: the column default is
-- evaluated before BEFORE triggers run, so a default-assigned seq could order
-- rows differently from the order in which they were chained.
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS TRIGGER AS $$
DECLARE
  last_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  NEW.seq := nextval(pg_get_serial_sequence('audit_log', 'seq'));
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
