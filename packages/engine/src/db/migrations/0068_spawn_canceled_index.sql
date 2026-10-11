-- `agent.register` runs a migration-tombstone check on every registration
-- (rejectMigrationCanceledSpawnRegistration): did a spawn invocation for this
-- (node, provider, agent-name) tuple get cancelled during the provider
-- migration? The only rows that can match carry
-- error = 'invocation_origin_unavailable' — ~2.9k rows in production — but the
-- planner was satisfying the query out of the status index instead, seeking the
-- whole status = 'failed' bucket (~216k rows, ~1.8s per registration) and
-- blowing the node-control liveness deadline that surfaces as d1_pressure on
-- every agent spawn. A partial index scoped to the tombstone predicate keeps
-- the check to the rows that can actually match. No data changes.
CREATE INDEX IF NOT EXISTS idx_action_invocations_spawn_canceled
  ON action_invocations(workspace_id, dispatched_node_id)
  WHERE status = 'failed' AND error = 'invocation_origin_unavailable';
