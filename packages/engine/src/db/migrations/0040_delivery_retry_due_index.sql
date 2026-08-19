-- Operational ordering: deploy the bounded expiry drain first and wait for the
-- expired-delivery backlog to clear before applying this migration. At the
-- projected ~150k-row steady state this scans ~150k table rows and, based on
-- the measured production shape, writes only ~54.6k non-NULL retry entries.
-- Wrangler D1 migrations are transactional and expose no per-file
-- `transaction: false` mode; the reduced build is intentionally small enough
-- to keep the transactional write lock short.
CREATE INDEX IF NOT EXISTS idx_deliveries_retry_due
  ON deliveries(status, next_attempt_at, created_at, id)
  WHERE next_attempt_at IS NOT NULL;
