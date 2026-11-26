-- trade_log.mode was the dashboard's mode at the moment a position closed, so a
-- paper position closed while LIVE was armed was filed as LIVE (and the reverse).
-- The broker that held the position is the truth: Upstox is LIVE, anything else PAPER.
UPDATE trade_log t
SET mode = CASE WHEN p.broker = 'UPSTOX' THEN 'LIVE' ELSE 'PAPER' END
FROM positions p
WHERE p.id = t.position_id
  AND t.mode IS DISTINCT FROM (CASE WHEN p.broker = 'UPSTOX' THEN 'LIVE' ELSE 'PAPER' END);
