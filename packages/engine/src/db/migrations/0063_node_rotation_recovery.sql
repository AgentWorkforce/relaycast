-- Recover an idempotent node-token rotation when its committed 201 response is
-- lost. Only hashes and a request digest are retained, and the engine accepts
-- the superseded proof only for the same high-entropy Idempotency-Key and body
-- during a bounded window.
ALTER TABLE nodes ADD COLUMN previous_token_hash TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN previous_token_expires_at INTEGER DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN rotation_idempotency_key_hash TEXT DEFAULT NULL;
ALTER TABLE nodes ADD COLUMN rotation_request_digest TEXT DEFAULT NULL;
