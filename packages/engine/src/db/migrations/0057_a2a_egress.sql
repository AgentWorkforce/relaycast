-- Durable accepted egress is committed with the message and capacity-guarded delivery.
CREATE TABLE IF NOT EXISTS a2a_egress (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  external_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  claim_token TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  error_status INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_a2a_egress_due ON a2a_egress(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_a2a_egress_retention ON a2a_egress(created_at, id);
