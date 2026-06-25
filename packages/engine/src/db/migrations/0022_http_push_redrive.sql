-- Keep due HTTP push retries cheap and reconcile binding-backed capacity counts.

CREATE INDEX IF NOT EXISTS idx_deliveries_http_push_due
  ON deliveries(workspace_id, route_node_kind, status, next_attempt_at);

UPDATE nodes
SET active_agents = (
  SELECT COUNT(*)
  FROM agent_node_bindings b
  WHERE b.workspace_id = nodes.workspace_id
    AND b.node_id = nodes.id
    AND b.status = 'active'
);
