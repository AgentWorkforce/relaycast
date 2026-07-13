-- The scheduled expiry sweep is global, so its oldest-first query needs an
-- index that does not begin with workspace_id. Restrict it to the two active
-- statuses to keep the index small as delivery history accumulates.
CREATE INDEX IF NOT EXISTS idx_deliveries_active_expiry
  ON deliveries(expires_at, id)
  WHERE status IN ('queued', 'delivered') AND expires_at IS NOT NULL;
