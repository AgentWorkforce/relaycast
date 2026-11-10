-- A strict spawn may restore and redispatch within the same epoch second.
-- Persist a monotonic generation so stale timeout/node-loss snapshots cannot
-- terminally settle a newer dispatch whose timestamp happens to collide.
ALTER TABLE action_invocations
  ADD COLUMN spawn_dispatch_generation INTEGER NOT NULL DEFAULT 0;

-- Migration 0042 added immutable completion-authority snapshots but did not
-- populate existing registered invocations. Recover rows whose referenced
-- action still exists; later runtime completion continues to use the snapshot,
-- not the mutable action row.
UPDATE action_invocations
SET handler_agent_id = (
      SELECT actions.handler_agent_id
      FROM actions
      WHERE actions.id = action_invocations.action_id
        AND actions.workspace_id = action_invocations.workspace_id
    ),
    handler_node_id = (
      SELECT actions.handler_node_id
      FROM actions
      WHERE actions.id = action_invocations.action_id
        AND actions.workspace_id = action_invocations.workspace_id
    )
WHERE invocation_origin = 'registered_action'
  AND action_id IS NOT NULL
  AND handler_agent_id IS NULL
  AND handler_node_id IS NULL;
