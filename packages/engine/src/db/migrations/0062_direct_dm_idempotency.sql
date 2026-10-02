-- Cloudflare KV is an eventually consistent replay cache and cannot provide
-- an atomic NX lock across isolates. This D1 claim is admitted in the same
-- transaction as the message, making a caller's Idempotency-Key one
-- database-enforced boundary across direct and A2A routing.
CREATE TABLE direct_dm_idempotency (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_direct_dm_idempotency_workspace_created
  ON direct_dm_idempotency(workspace_id, created_at);

CREATE INDEX idx_direct_dm_idempotency_retention
  ON direct_dm_idempotency(created_at, id);
