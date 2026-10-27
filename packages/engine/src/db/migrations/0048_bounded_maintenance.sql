-- Apply before running the bounded replay/retention engine. No history is deleted.
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_active_seq
  ON deliveries(workspace_id, agent_id, seq)
  WHERE status IN ('queued', 'delivered');
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_active_expiry
  ON deliveries(workspace_id, agent_id, expires_at)
  WHERE status IN ('queued', 'delivered');
CREATE INDEX IF NOT EXISTS idx_deliveries_initial_due
  ON deliveries(status, created_at, id) WHERE next_attempt_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_settled_retention
  ON deliveries(created_at, id)
  WHERE status IN ('acked', 'failed', 'dead_lettered');
CREATE INDEX IF NOT EXISTS idx_workspace_events_retention
  ON workspace_events(created_at, workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_retention ON messages(length(id), id);
CREATE INDEX IF NOT EXISTS idx_message_logs_retention ON message_logs(length(id), id);
CREATE TABLE IF NOT EXISTS maintenance_cursors (
  id TEXT PRIMARY KEY NOT NULL,
  cursor TEXT NOT NULL
);
