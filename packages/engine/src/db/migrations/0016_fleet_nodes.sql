-- Fleet Phase 1: node registry, node-native actions, agent locations, triggers.

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  capabilities TEXT NOT NULL DEFAULT '[]',
  max_agents INTEGER NOT NULL DEFAULT 0,
  active_agents INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  version TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'offline',
  handlers_live INTEGER NOT NULL DEFAULT 0,
  load REAL NOT NULL DEFAULT 0,
  last_heartbeat_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS nodes_workspace_name_unique
  ON nodes(workspace_id, name);

CREATE INDEX IF NOT EXISTS idx_nodes_workspace
  ON nodes(workspace_id);

CREATE INDEX IF NOT EXISTS idx_nodes_token
  ON nodes(token_hash);

CREATE INDEX IF NOT EXISTS idx_nodes_status
  ON nodes(workspace_id, status);

ALTER TABLE agents ADD COLUMN location_type TEXT NOT NULL DEFAULT 'self_connected';
ALTER TABLE agents ADD COLUMN location_node_id TEXT DEFAULT NULL REFERENCES nodes(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN resumable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN session_ref TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN origin_node_id TEXT DEFAULT NULL REFERENCES nodes(id) ON DELETE SET NULL;

ALTER TABLE actions RENAME TO actions_0016_old;
ALTER TABLE action_invocations RENAME TO action_invocations_0016_old;

DROP INDEX IF EXISTS actions_workspace_name_unique;
DROP INDEX IF EXISTS idx_actions_workspace;
DROP INDEX IF EXISTS idx_actions_handler;
DROP INDEX IF EXISTS idx_action_invocations_workspace;
DROP INDEX IF EXISTS idx_action_invocations_action;
DROP INDEX IF EXISTS idx_action_invocations_caller;

CREATE TABLE actions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  handler_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  handler_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  input_schema TEXT DEFAULT '{}',
  output_schema TEXT DEFAULT '{}',
  available_to TEXT DEFAULT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO actions (
  id,
  workspace_id,
  name,
  description,
  handler_agent_id,
  handler_node_id,
  input_schema,
  output_schema,
  available_to,
  is_active,
  created_at
)
SELECT
  id,
  workspace_id,
  name,
  description,
  handler_agent_id,
  NULL,
  input_schema,
  output_schema,
  available_to,
  is_active,
  created_at
FROM actions_0016_old;

CREATE UNIQUE INDEX actions_workspace_name_unique
  ON actions(workspace_id, name);

CREATE INDEX idx_actions_workspace
  ON actions(workspace_id);

CREATE INDEX idx_actions_handler
  ON actions(handler_agent_id);

CREATE INDEX idx_actions_node_handler
  ON actions(handler_node_id);

CREATE TABLE action_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
  action_name TEXT NOT NULL,
  caller_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  caller_name TEXT,
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT DEFAULT NULL,
  duration_ms INTEGER DEFAULT NULL,
  dispatched_node_id TEXT DEFAULT NULL REFERENCES nodes(id) ON DELETE SET NULL,
  dispatched_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER DEFAULT NULL
);

INSERT INTO action_invocations (
  id,
  workspace_id,
  action_id,
  action_name,
  caller_id,
  caller_name,
  input,
  output,
  status,
  error,
  duration_ms,
  dispatched_node_id,
  dispatched_at,
  created_at,
  completed_at
)
SELECT
  id,
  workspace_id,
  action_id,
  action_name,
  caller_id,
  caller_name,
  input,
  output,
  CASE WHEN status = 'invoked' THEN 'pending' ELSE status END,
  error,
  duration_ms,
  NULL,
  NULL,
  created_at,
  completed_at
FROM action_invocations_0016_old;

CREATE INDEX idx_action_invocations_workspace
  ON action_invocations(workspace_id, created_at);

CREATE INDEX idx_action_invocations_action
  ON action_invocations(action_id, created_at);

CREATE INDEX idx_action_invocations_caller
  ON action_invocations(caller_id, created_at);

CREATE INDEX idx_action_invocations_dispatched_node
  ON action_invocations(dispatched_node_id, created_at);

DROP TABLE action_invocations_0016_old;
DROP TABLE actions_0016_old;

CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel TEXT DEFAULT NULL,
  pattern TEXT DEFAULT NULL,
  mention INTEGER DEFAULT NULL,
  action_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_triggered_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_triggers_workspace
  ON triggers(workspace_id);

CREATE INDEX IF NOT EXISTS idx_triggers_enabled
  ON triggers(workspace_id, enabled);

CREATE INDEX IF NOT EXISTS idx_triggers_action
  ON triggers(workspace_id, action_name);
