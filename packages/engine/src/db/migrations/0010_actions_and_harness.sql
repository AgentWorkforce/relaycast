-- Add capabilities column to agents
ALTER TABLE agents ADD COLUMN capabilities TEXT DEFAULT NULL;

-- Create actions table (replaces commands)
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  handler_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  input_schema TEXT DEFAULT '{}',
  output_schema TEXT DEFAULT '{}',
  available_to TEXT DEFAULT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS actions_workspace_name_unique
  ON actions(workspace_id, name);

CREATE INDEX IF NOT EXISTS idx_actions_workspace
  ON actions(workspace_id);

CREATE INDEX IF NOT EXISTS idx_actions_handler
  ON actions(handler_agent_id);

-- Migrate existing commands into actions (preserve data)
INSERT OR IGNORE INTO actions (id, workspace_id, name, description, handler_agent_id, input_schema, is_active, created_at)
SELECT id, workspace_id, command, description, handler_agent_id,
  COALESCE(parameters, '[]'), is_active, created_at
FROM commands;

-- Drop old commands table
DROP TABLE IF EXISTS commands;

-- Action invocations (audit log)
CREATE TABLE IF NOT EXISTS action_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id TEXT REFERENCES actions(id) ON DELETE SET NULL,
  action_name TEXT NOT NULL,
  caller_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  caller_name TEXT,
  input TEXT DEFAULT '{}',
  output TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'invoked',
  error TEXT DEFAULT NULL,
  duration_ms INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_action_invocations_workspace
  ON action_invocations(workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_action_invocations_action
  ON action_invocations(action_id, created_at);

CREATE INDEX IF NOT EXISTS idx_action_invocations_caller
  ON action_invocations(caller_id, created_at);

-- Session events (harness-emitted observations)
CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_session_events_agent
  ON session_events(agent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_session_events_workspace
  ON session_events(workspace_id, created_at);

CREATE INDEX IF NOT EXISTS idx_session_events_type
  ON session_events(workspace_id, type, created_at);

-- Deliveries (per-recipient message delivery tracking)
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'immediate',
  reason TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  deadline INTEGER DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retryable INTEGER DEFAULT NULL,
  available_at INTEGER DEFAULT NULL,
  error TEXT DEFAULT NULL,
  idempotency_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_deliveries_message
  ON deliveries(message_id);

CREATE INDEX IF NOT EXISTS idx_deliveries_agent
  ON deliveries(agent_id, created_at);

CREATE INDEX IF NOT EXISTS idx_deliveries_status
  ON deliveries(workspace_id, status, created_at);
