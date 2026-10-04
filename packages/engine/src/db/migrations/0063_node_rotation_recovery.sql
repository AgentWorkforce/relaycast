-- Recover an idempotent node-token rotation when its committed 201 response is
-- lost. Only hashes and a request digest are retained, and the engine accepts
-- the superseded proof only for the same high-entropy Idempotency-Key and body
-- during a bounded window.
ALTER TABLE nodes ADD COLUMN previous_token_hash TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN previous_token_expires_at INTEGER DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN rotation_idempotency_key_hash TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN rotation_request_digest TEXT DEFAULT NULL;

-- Recovery can fall back to a superseded proof after id/name/machine lookup
-- misses. Keep that lookup bounded to the requesting workspace.
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_previous_token
  ON nodes(workspace_id, previous_token_hash);
