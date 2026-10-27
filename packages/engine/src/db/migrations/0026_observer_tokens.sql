-- Add scoped observer tokens for workspace realtime and read-only REST.

CREATE TABLE observer_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  filters TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  expires_at INTEGER,
  created_by TEXT,
  created_by_type TEXT NOT NULL DEFAULT 'workspace',
  last_used_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER,
  revoked_at INTEGER,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX observer_tokens_workspace_name_unique
  ON observer_tokens (workspace_id, name);

CREATE UNIQUE INDEX observer_tokens_token_hash_unique
  ON observer_tokens (token_hash);

CREATE INDEX idx_observer_tokens_workspace_status
  ON observer_tokens (workspace_id, status);

CREATE INDEX idx_observer_tokens_expires_at
  ON observer_tokens (expires_at);
