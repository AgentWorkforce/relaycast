CREATE TABLE IF NOT EXISTS webhook_delivery_dead_letters (
  delivery_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT NOT NULL,
  failed_at TEXT NOT NULL,
  replay_count INTEGER NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
  status TEXT NOT NULL DEFAULT 'dead_lettered',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_dead_letters_workspace_failed_at
  ON webhook_delivery_dead_letters (workspace_id, failed_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_delivery_dead_letters_event_id
  ON webhook_delivery_dead_letters (event_id);
