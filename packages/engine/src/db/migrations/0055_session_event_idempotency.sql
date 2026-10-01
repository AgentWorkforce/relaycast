-- relaycast#423: make optional Idempotency-Key event publication durable.
-- NULL identity columns preserve the historical append-only behavior for
-- callers that do not send a key.
ALTER TABLE session_events ADD COLUMN idempotency_key_hash TEXT;
ALTER TABLE session_events ADD COLUMN request_digest TEXT;

CREATE UNIQUE INDEX session_events_agent_idempotency_unique
  ON session_events(workspace_id, agent_id, idempotency_key_hash);
