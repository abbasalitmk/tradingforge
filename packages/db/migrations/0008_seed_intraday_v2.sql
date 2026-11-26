-- Retire superseded @v1 CANDIDATE parameter sets for PDH_PDL_CPR and ORB_SUPERTREND_15M
-- and seed @v2 candidates matching the empirically validated 12-month live-parity defaults.
UPDATE strategy_versions
SET status = 'RETIRED'
WHERE status = 'CANDIDATE'
  AND version = 1
  AND strategy_id IN ('PDH_PDL_CPR', 'ORB_SUPERTREND_15M');

INSERT INTO strategy_versions (id, strategy_id, version, params, status, origin, hypothesis)
SELECT
  'PDH_PDL_CPR@v2',
  'PDH_PDL_CPR',
  2,
  '{"atrPeriod":14,"maxCprWidthPct":0.9,"minVolumeRatio":1.3,"volumePeriod":20,"stopBufferAtr":0.3,"minStopAtr":1,"maxStopAtr":3,"targetRR":2,"minConfidence":60}'::jsonb,
  'CANDIDATE',
  'DEFAULT',
  'Relaxed narrow-CPR filter (0.9%) + 1.3x volume + 1.0 ATR minimum structural stop passes all 6 validation gates (+0.43R, 39 trades, 3/4 folds, 100% parameter stability, +0.08R 2x cost stress).'
WHERE NOT EXISTS (SELECT 1 FROM strategy_versions WHERE id = 'PDH_PDL_CPR@v2');

INSERT INTO strategy_versions (id, strategy_id, version, params, status, origin, hypothesis)
SELECT
  'ORB_SUPERTREND_15M@v2',
  'ORB_SUPERTREND_15M',
  2,
  '{"orbMinutes":30,"atrPeriod":14,"stopAtrMultiple":2,"targetRR":2,"minRelativeVolume":1.5,"minAdx":25,"rsiUpper":72,"rsiLower":28,"freshBars":1,"minConfidence":70}'::jsonb,
  'CANDIDATE',
  'DEFAULT',
  '30-min opening range on closed 15m bars (first breakout bar only) with hard Supertrend, EMA9/21, VWAP, ADX>=25, close location >=0.55 and 0.75% stop floor passes all 6 validation gates (+0.19R, 60 trades, 4/4 folds, 100% parameter stability, +0.03R 2x cost stress).'
WHERE NOT EXISTS (SELECT 1 FROM strategy_versions WHERE id = 'ORB_SUPERTREND_15M@v2');
