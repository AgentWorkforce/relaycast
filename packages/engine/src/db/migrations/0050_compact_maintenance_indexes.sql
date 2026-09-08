-- Supersedes 0048/0049 for installations that have not applied them. Published
-- migration files stay immutable; the explicit planner records only SQL run.
-- Release obsolete non-unique indexes BEFORE allocating their replacements.
-- No rows, retention policy, foreign keys, or uniqueness constraints change.
-- Message lookup/FK probes remain covered by deliveries_message_agent_unique.
DROP INDEX IF EXISTS idx_deliveries_message;
DROP INDEX IF EXISTS idx_read_receipts_message;
-- These legacy route/redrive indexes have no runtime hints; bounded redrive
-- uses the route-matched global/workspace indexes created below instead.
DROP INDEX IF EXISTS idx_deliveries_route_node;
DROP INDEX IF EXISTS idx_deliveries_next_attempt;
DROP INDEX IF EXISTS idx_deliveries_http_push_due;
-- 0049 replaced this broad initial-attempt index; never allocate it anew.
DROP INDEX IF EXISTS idx_deliveries_initial_due;

CREATE INDEX IF NOT EXISTS idx_deliveries_agent_active_seq
  ON deliveries(workspace_id, agent_id, seq)
  WHERE status IN ('queued', 'delivered');
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_active_expiry
  ON deliveries(workspace_id, agent_id, expires_at)
  WHERE status IN ('queued', 'delivered');
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_id_lookup ON deliveries(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_read_receipts_retention ON read_receipts(message_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_node_initial ON deliveries(created_at, id)
  WHERE status = 'queued' AND route_node_kind IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND next_attempt_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_node_initial_workspace ON deliveries(workspace_id, created_at, id)
  WHERE status = 'queued' AND route_node_kind IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND next_attempt_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_node_retry ON deliveries(next_attempt_at, created_at, id)
  WHERE status = 'queued' AND route_node_kind IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND next_attempt_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deliveries_node_retry_workspace ON deliveries(workspace_id, next_attempt_at, created_at, id)
  WHERE status = 'queued' AND route_node_kind IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND next_attempt_at IS NOT NULL;
