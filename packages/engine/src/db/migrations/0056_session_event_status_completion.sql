-- relaycast#425: track whether a status.* session event's agent-row mutation
-- durably completed. NULL means "not yet applied" so a replay after a crash
-- between the event insert and the agent status write can finish the
-- interrupted mutation instead of silently skipping it. Legacy keyed rows
-- are marked for reconciliation below because their old route wrote the
-- event and agent row separately, so completion is otherwise ambiguous.
-- `status_updated_at` is a conservative write-time witness for that
-- reconciliation. It is initialized from the agent's last known liveness
-- write because older rows have no historical status-write clock. The trigger
-- advances it for every later status or liveness write, so a legacy replay
-- may mutate only when the row is demonstrably older than the event itself.
ALTER TABLE agents ADD COLUMN status_updated_at INTEGER;
ALTER TABLE session_events ADD COLUMN status_applied_at INTEGER;
ALTER TABLE session_events ADD COLUMN status_legacy_pending INTEGER NOT NULL DEFAULT 0;

UPDATE agents
SET status_updated_at = last_seen
WHERE status_updated_at IS NULL;

CREATE TRIGGER agents_status_reconciliation_timestamp
AFTER UPDATE OF status, last_seen ON agents
FOR EACH ROW
BEGIN
  UPDATE agents
  SET status_updated_at = unixepoch()
  WHERE id = NEW.id;
END;

-- Before these markers existed, a keyed status event was inserted before the
-- agent-row update. Keep completion NULL so an interrupted mutation can be
-- recovered only when the agent row is demonstrably older than the event. An
-- equal or newer timestamp is conservatively treated as already handled (or
-- changed by another writer), so replay cannot clobber a later status or
-- heartbeat when the old route's outcome is ambiguous.
UPDATE session_events
SET status_legacy_pending = 1
WHERE idempotency_key_hash IS NOT NULL
  AND type LIKE 'status.%';
