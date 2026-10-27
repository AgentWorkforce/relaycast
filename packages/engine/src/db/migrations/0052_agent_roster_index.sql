-- Roster reads exclude tombstones; active/online reads also seek by liveness.
-- Keep the query's released predicate literal so prepared queries qualify.
CREATE INDEX IF NOT EXISTS idx_agents_roster
  ON agents(workspace_id, status, last_seen) WHERE status <> 'released';
