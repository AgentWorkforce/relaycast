-- relaycast#311: recovery authorization must be server-owned and explicit.
-- No existing token or agent row is changed by this migration.

CREATE TABLE agent_recovery_credentials (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  proof_kind TEXT NOT NULL,
  verifier_hash TEXT NOT NULL,
  work_unit_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_recovery_credentials_agent_unique
  ON agent_recovery_credentials(workspace_id, agent_id);
CREATE UNIQUE INDEX agent_recovery_credentials_verifier_unique
  ON agent_recovery_credentials(verifier_hash);
CREATE TABLE agent_identity_audit (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  action TEXT NOT NULL,
  authority TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  session_ref TEXT,
  node_id TEXT,
  origin_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_identity_audit_workspace
  ON agent_identity_audit(workspace_id, created_at);
CREATE INDEX idx_agent_identity_audit_agent
  ON agent_identity_audit(workspace_id, agent_id, created_at);
