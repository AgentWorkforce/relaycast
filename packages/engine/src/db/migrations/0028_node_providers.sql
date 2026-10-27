-- Multi-provider nodes and node-scoped actions.
--
-- A node hosts N providers (the broker plus capability providers). Provider
-- capability sets persist in node_providers so an offline node still shows its
-- full manifest, and per-provider liveness/capacity aggregates onto the nodes
-- row. Actions become node-scoped with a recorded handler provider; a node
-- action may claim a workspace-global alias.

ALTER TABLE nodes ADD COLUMN machine_id TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN provider_name TEXT NOT NULL DEFAULT 'default';
ALTER TABLE actions ADD COLUMN handler_provider TEXT DEFAULT NULL;
ALTER TABLE actions ADD COLUMN is_global INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actions ADD COLUMN queue INTEGER NOT NULL DEFAULT 0;

CREATE TABLE node_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '[]',
  max_agents INTEGER NOT NULL DEFAULT 0,
  active_agents INTEGER NOT NULL DEFAULT 0,
  load REAL NOT NULL DEFAULT 0,
  handlers_live INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'offline',
  version TEXT NOT NULL DEFAULT 'unknown',
  last_heartbeat_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX node_providers_node_name_unique ON node_providers (workspace_id, node_id, name);
CREATE INDEX idx_node_providers_node ON node_providers (workspace_id, node_id);

-- Existing node-hosted actions were owned by the broker; record it and let them
-- keep resolving through the workspace-scoped invoke as global aliases.
UPDATE actions SET handler_provider = 'default', is_global = 1 WHERE handler_node_id IS NOT NULL;

-- Every broker node becomes its own `default` provider carrying its manifest.
INSERT INTO node_providers (
  id, workspace_id, node_id, name, instance_id, capabilities,
  max_agents, active_agents, load, handlers_live, status, version, last_heartbeat_at, created_at
)
SELECT
  'nprov_' || id, workspace_id, id, 'default', 'migrated', capabilities,
  max_agents, active_agents, load, handlers_live, status, version, last_heartbeat_at, created_at
FROM nodes
WHERE role = 'broker';

-- Node-scoped uniqueness replaces the workspace-global unique; agent-hosted and
-- global-alias uniqueness are enforced by partial indexes.
DROP INDEX IF EXISTS actions_workspace_name_unique;
CREATE UNIQUE INDEX actions_workspace_node_name_unique ON actions (workspace_id, handler_node_id, name);
CREATE UNIQUE INDEX actions_workspace_agent_name_unique ON actions (workspace_id, name) WHERE handler_node_id IS NULL;
CREATE UNIQUE INDEX actions_workspace_global_name_unique ON actions (workspace_id, name) WHERE is_global = 1;
