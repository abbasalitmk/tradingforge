-- HOLY_GRAIL_15M and INSIDE_BAR_15M were added on 26 Nov 2026 from a 3-month test
-- (Aug–Nov 2026). On 20 months of NSE 5-minute data (Mar 2025 – Nov 2026, 40 stocks,
-- production rules, full charges) both lose: HOLY_GRAIL_15M −0.258R a trade over 606
-- trades, INSIDE_BAR_15M −0.127R over 278. Record that as a failed validation so
-- "Skip failed strategies" keeps them from leading and from voting, in every mode.
UPDATE strategy_versions v
SET status = 'REJECTED',
    validated_at = now(),
    validation = jsonb_build_object(
      'status', 'REJECTED',
      'source', '20-month backtest, Mar 2025 – Nov 2026, 40 NSE stocks, production rules',
      'outOfSample', jsonb_build_object('expectancyR', r.expectancy, 'trades', r.trades)
    )
FROM (VALUES ('HOLY_GRAIL_15M', -0.258, 606), ('INSIDE_BAR_15M', -0.127, 278)) AS r(strategy_id, expectancy, trades)
WHERE v.strategy_id = r.strategy_id
  AND v.status = 'CANDIDATE';
