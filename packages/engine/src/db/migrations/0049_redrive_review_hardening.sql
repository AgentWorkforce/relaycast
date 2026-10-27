-- Append-only follow-up: 0048 may already exist on a developer/staging DB.
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
