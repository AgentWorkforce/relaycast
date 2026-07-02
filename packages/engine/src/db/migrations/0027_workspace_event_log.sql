-- Durable workspace event log: per-workspace, seq-cursored copy of every
-- workspace stream event so observers can reconcile after reconnects.

CREATE TABLE workspace_events (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq > 0),
  type TEXT NOT NULL,
  channel_id TEXT,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (workspace_id, seq)
);
CREATE INDEX idx_workspace_events_created ON workspace_events(workspace_id, created_at);
