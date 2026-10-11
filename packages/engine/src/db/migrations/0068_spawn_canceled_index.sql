-- `agent.register` runs a migration-tombstone check on every registration
-- (rejectMigrationCanceledSpawnRegistration): did a spawn invocation for this
-- (node, provider, agent-name) tuple get cancelled during the provider
-- migration? Only rows with error = 'invocation_origin_unavailable' can match
-- (~2.9k in production) — but the planner was satisfying the query out of the
-- status index instead, seeking the whole status = 'failed' bucket (~216k
-- rows, ~1.8s per registration) and blowing the node-control liveness
-- deadline that surfaces as d1_pressure on every agent spawn.
--
-- A partial index on the tombstone predicates was the first cut, but the
-- check binds status and error through parameters, and SQLite cannot prove a
-- bound parameter satisfies a partial WHERE clause — the same lesson 0065
-- recorded for the task deadline sweep. This composite is non-partial: the
-- (workspace_id, dispatched_node_id) equality seek narrows to the handful of
-- invocations a node has ever seen, and the same seek also serves the
-- spawn-reservation EXISTS inside reserveNodeAgentSlot (~541 rows measured).
-- No data changes.
CREATE INDEX IF NOT EXISTS idx_action_invocations_spawn_canceled
  ON action_invocations(workspace_id, dispatched_node_id);
