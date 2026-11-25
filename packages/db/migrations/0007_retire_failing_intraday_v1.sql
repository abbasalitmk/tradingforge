-- Retire legacy @v1 intraday versions that failed out-of-sample / walk-forward / cost validation
-- so negative-expectancy v1 rules cannot lead LIVE entries after deployment.
UPDATE strategy_versions
SET status = 'RETIRED'
WHERE status = 'APPROVED'
  AND version = 1
  AND validation IS NOT NULL
  AND (validation->>'status') = 'REJECTED'
  AND strategy_id IN (
    'ORB_SUPERTREND',
    'VWAP_PULLBACK',
    'SUPERTREND_MOMENTUM',
    'BB_SQUEEZE_BREAKOUT',
    'GMMA_TREND',
    'SMC_STRUCTURE',
    'TECHNICAL_COMPOSITE'
  );
