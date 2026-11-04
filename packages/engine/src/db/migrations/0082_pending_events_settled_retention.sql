-- Retention filters settled events by completed_at. The dispatch index on
-- (status, process_after) otherwise scans every retained row of each status.
CREATE INDEX IF NOT EXISTS idx_pending_events_settled_retention
  ON pending_events(status, completed_at, id);
