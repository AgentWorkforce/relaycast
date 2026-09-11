-- relaycast#425: track whether a status.* session event's agent-row mutation
-- durably completed. NULL means "not yet applied" so a replay after a crash
-- between the event insert and the agent status write can finish the
-- interrupted mutation instead of silently skipping it.
ALTER TABLE session_events ADD COLUMN status_applied_at INTEGER;

-- Before this marker existed, a keyed status event was marked successful by
-- the route after its agent-row update, but there was no durable bit to carry
-- that fact. Treat those historical rows as completed at their event time so
-- a retry after migration does not replay the status effect or fan out again.
-- Unkeyed events never had replay semantics and remain NULL; new rows are
-- NULL until applyStatusEventEffect completes them atomically.
UPDATE session_events
SET status_applied_at = created_at
WHERE idempotency_key_hash IS NOT NULL
  AND type LIKE 'status.%'
  AND status_applied_at IS NULL;
