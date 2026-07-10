CREATE TABLE IF NOT EXISTS workspace_stats (
  workspace_id TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL DEFAULT 0 CHECK (file_count >= 0),
  directory_count INTEGER NOT NULL DEFAULT 0 CHECK (directory_count >= 0),
  bytes_stored INTEGER NOT NULL DEFAULT 0 CHECK (bytes_stored >= 0),
  operation_count INTEGER NOT NULL DEFAULT 0 CHECK (operation_count >= 0),
  dead_letter_count INTEGER NOT NULL DEFAULT 0 CHECK (dead_letter_count >= 0),
  last_ingested_at TEXT,
  last_event_at TEXT,
  last_writeback_at TEXT,
  last_activity TEXT,
  provider_status_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_stats_updated_at
  ON workspace_stats (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_stats_dead_letter_count
  ON workspace_stats (dead_letter_count DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_stats_last_activity
  ON workspace_stats (last_activity ASC);

CREATE TABLE IF NOT EXISTS dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  headers_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NOT NULL,
  replayable INTEGER NOT NULL DEFAULT 1 CHECK (replayable IN (0, 1)),
  failed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dead_letters_envelope
  ON dead_letters (workspace_id, envelope_id);

CREATE INDEX IF NOT EXISTS idx_dead_letters_workspace_failed_at
  ON dead_letters (workspace_id, failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letters_provider_failed_at
  ON dead_letters (provider, failed_at DESC);
