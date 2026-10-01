-- Presence cleanup runs from host maintenance rather than roster reads. Keep
-- both its future-clock normalization and stale-offline updates on the small
-- active presence set, ordered by the timestamp range each update applies.
CREATE INDEX IF NOT EXISTS idx_agents_active_last_seen
  ON agents(last_seen)
  WHERE status IN ('active', 'online');

-- Agent detail and mailbox replay only need non-terminal delivery rows. Match
-- the request scope and FIFO order while excluding retained terminal history;
-- the read predicate still filters any expired row awaiting the scheduled sweep.
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_active_created
  ON deliveries(workspace_id, agent_id, created_at, id)
  WHERE status IN ('queued', 'delivered');
