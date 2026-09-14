-- Row-level triggers do not fire on TRUNCATE, so the append-only guarantee from
-- 0002 had a hole: TRUNCATE audit_log would silently erase the entire chain.
-- A statement-level trigger closes it.

CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (attempted TRUNCATE)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON audit_log;
CREATE TRIGGER trg_audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
