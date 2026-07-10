CREATE TABLE IF NOT EXISTS slack_writeback_idempotency (
  key TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider_config_key TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  thread_ts TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_slack_writeback_idempotency_expires_at
  ON slack_writeback_idempotency (expires_at);
