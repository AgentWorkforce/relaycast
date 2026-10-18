-- Run-scoped Relaycast credentials (`rt_live_`). A run authority is the
-- durable, per-workspace record that a Cloud run may mint short-lived run
-- tokens. Revocation is permanent: a revoked authority never mints again, and
-- every agent/node credential stamped with that run stops authenticating.
CREATE TABLE IF NOT EXISTS run_authorities (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER DEFAULT NULL,
  PRIMARY KEY (workspace_id, run_id)
);

-- Only SHA-256 hashes of run tokens are stored.
CREATE TABLE IF NOT EXISTS run_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER DEFAULT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_tokens_workspace_run
  ON run_tokens(workspace_id, run_id);

-- Agents and nodes created under a run credential carry the run id so the
-- run's revocation can cascade to them. NULL means workspace-owned.
ALTER TABLE agents ADD COLUMN run_id TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN run_id TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_workspace_run
  ON agents(workspace_id, run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_run
  ON nodes(workspace_id, run_id) WHERE run_id IS NOT NULL;
