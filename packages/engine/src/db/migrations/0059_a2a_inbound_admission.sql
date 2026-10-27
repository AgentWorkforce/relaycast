-- Additive to frozen 0057/0058. No credentials are retained in admission context.
CREATE INDEX IF NOT EXISTS idx_a2a_egress_workspace ON a2a_egress(workspace_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS a2a_inbound (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  response TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_workspace ON a2a_inbound(workspace_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_message ON a2a_inbound(message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_a2a_inbound_retention ON a2a_inbound(created_at, id);
--> statement-breakpoint

-- Preserve the bounded identity/fingerprint tombstone, but never retain source
-- content after pruning. The FK nulls message_id in the same delete statement.
CREATE TRIGGER IF NOT EXISTS a2a_inbound_source_prune
BEFORE DELETE ON messages
BEGIN
  UPDATE a2a_inbound SET response = NULL WHERE message_id = OLD.id;
END;
