CREATE TABLE IF NOT EXISTS webhook_envelopes (
  envelope_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  correlation_id TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_envelopes_workspace_received_at
  ON webhook_envelopes (workspace_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_envelopes_status_updated_at
  ON webhook_envelopes (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_operations (
  op_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  revision TEXT NOT NULL,
  action TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  last_error TEXT,
  provider_result_json TEXT,
  correlation_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_workspace_status
  ON workspace_operations (workspace_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_operations_provider_status
  ON workspace_operations (provider, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS sync_refresh_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sync_refresh_jobs_workspace_created_at
  ON sync_refresh_jobs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_refresh_jobs_status_created_at
  ON sync_refresh_jobs (status, created_at DESC);
