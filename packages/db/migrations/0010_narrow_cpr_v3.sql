-- The narrow-CPR filter at 0.9% did not filter: |TC − BC| is at most a third of the
-- prior day's range, so it only bound after a 2.7%+ day. Retire unapproved parameter
-- sets still on the wide setting and seed the next version with the 0.3% default
-- the live analyzer now runs. Aug–Nov 2026, 40 NSE stocks, live-parity rules:
-- PDH_PDL_CPR_15M went from 95 trades at −0.29R to 27 at −0.12R.
UPDATE strategy_versions
SET status = 'RETIRED'
WHERE status IN ('CANDIDATE', 'REJECTED', 'VALIDATED')
  AND strategy_id IN ('PDH_PDL_CPR', 'PDH_PDL_CPR_15M')
  AND (params->>'maxCprWidthPct')::numeric > 0.3;

INSERT INTO strategy_versions (id, strategy_id, version, params, status, origin, hypothesis)
SELECT
  s.strategy_id || '@v' || (COALESCE(MAX(v.version), 0) + 1),
  s.strategy_id,
  COALESCE(MAX(v.version), 0) + 1,
  s.params,
  'CANDIDATE',
  'DEFAULT',
  'Narrow CPR means narrow: maxCprWidthPct 0.3 (was 0.9, which almost never rejected a day).'
FROM (VALUES
  ('PDH_PDL_CPR', '{"atrPeriod":14,"maxCprWidthPct":0.3,"minVolumeRatio":1.3,"volumePeriod":20,"stopBufferAtr":0.3,"minStopAtr":1,"maxStopAtr":3,"targetRR":2,"minConfidence":60}'::jsonb),
  ('PDH_PDL_CPR_15M', '{"atrPeriod":14,"maxCprWidthPct":0.3,"minVolumeRatio":1.5,"volumePeriod":20,"stopBufferAtr":0.3,"minStopAtr":0.75,"maxStopAtr":2.5,"targetRR":2,"minConfidence":60}'::jsonb)
) AS s(strategy_id, params)
LEFT JOIN strategy_versions v ON v.strategy_id = s.strategy_id
WHERE NOT EXISTS (
  SELECT 1 FROM strategy_versions x
  WHERE x.strategy_id = s.strategy_id AND (x.params->>'maxCprWidthPct')::numeric = 0.3
)
GROUP BY s.strategy_id, s.params;
