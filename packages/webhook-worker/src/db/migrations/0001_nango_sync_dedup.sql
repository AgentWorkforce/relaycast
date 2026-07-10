CREATE TABLE IF NOT EXISTS nango_sync_dedup (
  surface TEXT NOT NULL,
  dedupe_id TEXT NOT NULL,
  workspace_id TEXT,
  provider TEXT,
  connection_id TEXT,
  provider_config_key TEXT,
  sync_name TEXT,
  model TEXT,
  sync_window_key TEXT,
  cursor_key TEXT,
  payload_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 1,
  lease_expires_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (surface, dedupe_id)
);

CREATE INDEX IF NOT EXISTS nango_sync_dedup_status_lease_idx
  ON nango_sync_dedup (status, lease_expires_at);
