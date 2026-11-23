-- Position journal. The positions table from 0001 becomes the engine's source
-- of truth across restarts: every state transition upserts the row BEFORE the
-- in-memory state changes, and boot replays the non-terminal rows.
--
-- `broker` records which order path opened the position; its exits always go
-- back there, whatever mode the dashboard is in. `snapshot` carries the full
-- managed record (segment, product, contract, strategy, excursions) so a
-- restart restores exactly what was being managed.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS broker TEXT NOT NULL DEFAULT 'PAPER'
  CHECK (broker IN ('PAPER','UPSTOX'));
ALTER TABLE positions ADD COLUMN IF NOT EXISTS snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_positions_closed ON positions (closed_at DESC)
  WHERE closed_at IS NOT NULL;
