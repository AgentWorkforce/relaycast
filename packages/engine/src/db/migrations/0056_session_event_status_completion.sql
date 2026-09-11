-- relaycast#425: track whether a status.* session event's agent-row mutation
-- durably completed. NULL means "not yet applied" so a replay after a crash
-- between the event insert and the agent status write can finish the
-- interrupted mutation instead of silently skipping it.
ALTER TABLE session_events ADD COLUMN status_applied_at INTEGER;
