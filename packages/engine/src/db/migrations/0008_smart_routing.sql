CREATE TABLE IF NOT EXISTS routing_configs (
  workspace_id TEXT PRIMARY KEY NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  weights TEXT NOT NULL DEFAULT '{}',
  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 3,
  circuit_breaker_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_routing_configs_updated_at
  ON routing_configs(updated_at);

CREATE TABLE IF NOT EXISTS routing_failures (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_successes INTEGER NOT NULL DEFAULT 0,
  last_failure_at INTEGER,
  last_success_at INTEGER,
  circuit_open_until INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_routing_failures_workspace
  ON routing_failures(workspace_id, updated_at);

CREATE INDEX IF NOT EXISTS idx_routing_failures_circuit
  ON routing_failures(workspace_id, circuit_open_until);
