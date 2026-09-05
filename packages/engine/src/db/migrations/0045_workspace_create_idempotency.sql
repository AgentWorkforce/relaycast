-- relaycast#371: bind delegated workspace creation to an owner-scoped,
-- request-digested idempotency key. The child bearer key is derived at replay
-- time and is never persisted in plaintext.
CREATE TABLE workspace_create_idempotency (
  owner_scope_hash TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  terminalized_at INTEGER,
  PRIMARY KEY (owner_scope_hash, idempotency_key_hash)
);

CREATE UNIQUE INDEX workspace_create_idempotency_workspace_unique
  ON workspace_create_idempotency(workspace_id);
CREATE INDEX idx_workspace_create_idempotency_workspace
  ON workspace_create_idempotency(workspace_id);
