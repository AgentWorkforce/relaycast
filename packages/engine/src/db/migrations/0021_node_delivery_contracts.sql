-- Nodes as routeable delivery hosts, with explicit delivery contracts.

ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'fleet_ws';
ALTER TABLE nodes ADD COLUMN delivery_adapter TEXT NOT NULL DEFAULT 'fleet.ws.v1';
ALTER TABLE nodes ADD COLUMN delivery_config TEXT DEFAULT NULL;

CREATE TABLE IF NOT EXISTS agent_node_bindings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  session_ref TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER,
  UNIQUE(agent_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_workspace
  ON agent_node_bindings(workspace_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_agent
  ON agent_node_bindings(workspace_id, agent_id, status);

CREATE INDEX IF NOT EXISTS idx_agent_node_bindings_node
  ON agent_node_bindings(workspace_id, node_id, status);

-- Backfill explicit bindings for existing fleet-hosted agents.
INSERT OR IGNORE INTO agent_node_bindings (
  id,
  workspace_id,
  agent_id,
  node_id,
  status,
  session_ref,
  priority,
  created_at
)
SELECT
  'anb_' || id,
  workspace_id,
  id,
  location_node_id,
  'active',
  session_ref,
  0,
  unixepoch()
FROM agents
WHERE location_type = 'via_node'
  AND location_node_id IS NOT NULL;

ALTER TABLE deliveries ADD COLUMN route_node_id TEXT DEFAULT NULL REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE deliveries ADD COLUMN route_node_kind TEXT DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN delivery_adapter TEXT DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN next_attempt_at INTEGER DEFAULT NULL;
ALTER TABLE deliveries ADD COLUMN last_dispatch_error TEXT DEFAULT NULL;

UPDATE deliveries
SET
  route_node_id = location_node_id,
  route_node_kind = CASE WHEN location_node_id IS NOT NULL THEN 'fleet_ws' ELSE NULL END,
  delivery_adapter = CASE WHEN location_node_id IS NOT NULL THEN 'fleet.ws.v1' ELSE NULL END;

CREATE INDEX IF NOT EXISTS idx_deliveries_route_node
  ON deliveries(workspace_id, route_node_id, status, seq);

CREATE INDEX IF NOT EXISTS idx_deliveries_next_attempt
  ON deliveries(workspace_id, status, next_attempt_at);
