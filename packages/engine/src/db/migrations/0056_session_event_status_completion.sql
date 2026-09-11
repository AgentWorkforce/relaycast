-- relaycast#425: track whether a status.* session event's agent-row mutation
-- durably completed. NULL means "not yet applied" so a replay after a crash
-- between the event insert and the agent status write can finish the
-- interrupted mutation instead of silently skipping it. Legacy keyed rows
-- are marked for reconciliation below because their old route wrote the
-- event and agent row separately, so completion is otherwise ambiguous.
ALTER TABLE session_events ADD COLUMN status_applied_at INTEGER;
ALTER TABLE session_events ADD COLUMN status_legacy_pending INTEGER NOT NULL DEFAULT 0;

-- Before these markers existed, a keyed status event was inserted before the
-- agent-row update. Keep completion NULL so an interrupted mutation can be
-- recovered; the legacy bit lets replay suppress duplicate side effects when
-- the current agent row already proves this event's requested status.
UPDATE session_events
SET status_legacy_pending = 1
WHERE idempotency_key_hash IS NOT NULL
  AND type LIKE 'status.%';
