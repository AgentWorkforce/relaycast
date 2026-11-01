-- Node-scoped context fanout (presence above all) reaches only http_push nodes
-- and WebSocket nodes that are not offline. Driven from active bindings, every
-- presence event read each bound agent in the workspace, most of them on
-- offline direct nodes. This partial index holds just the reachable nodes; the
-- fanout query names the same literal predicate so SQLite can prove it and
-- start from here. No data changes.
CREATE INDEX IF NOT EXISTS idx_nodes_context_reachable
  ON nodes(workspace_id, id)
  WHERE kind = 'http_push' OR (kind IN ('ws', 'fleet_ws', 'direct_ws') AND status <> 'offline');
