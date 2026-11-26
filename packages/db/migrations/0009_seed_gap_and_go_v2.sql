-- Retire stale @v1 CANDIDATE parameter set for GAP_AND_GO (1.5% min gap / 2.0x RVOL)
-- and seed @v2 matching the updated 1.0–4.5% / 1.6x opening RVOL defaults.
UPDATE strategy_versions
SET status = 'RETIRED'
WHERE status IN ('CANDIDATE', 'REJECTED')
  AND version = 1
  AND strategy_id = 'GAP_AND_GO';

INSERT INTO strategy_versions (id, strategy_id, version, params, status, origin, hypothesis)
SELECT
  'GAP_AND_GO@v2',
  'GAP_AND_GO',
  2,
  '{"atrPeriod":14,"minGapPct":1,"maxGapPct":4.5,"openingBars":3,"minOpeningRvol":1.6,"maxSessionBars":18,"stopBufferAtr":0.1,"minStopAtr":0.5,"maxStopAtr":3,"targetRR":2,"minConfidence":60}'::jsonb,
  'CANDIDATE',
  'DEFAULT',
  'Synced v2 defaults (1.0–4.5% gap, 1.6x opening RVOL) that produced +0.39R, 71% win rate, and +0.30R out-of-sample across 12-month live-parity testing.'
WHERE NOT EXISTS (SELECT 1 FROM strategy_versions WHERE id = 'GAP_AND_GO@v2');
