-- Backfill immutable completion-authority snapshots for registered invocations
-- created before migration 0042. The referenced action is used once here;
-- later completion reads only the invocation-owned values.
UPDATE "action_invocations"
SET "handler_agent_id" = "actions"."handler_agent_id",
    "handler_node_id" = "actions"."handler_node_id"
FROM "actions"
WHERE "actions"."id" = "action_invocations"."action_id"
  AND "actions"."workspace_id" = "action_invocations"."workspace_id"
  AND "action_invocations"."invocation_origin" = 'registered_action'
  AND "action_invocations"."handler_agent_id" IS NULL
  AND "action_invocations"."handler_node_id" IS NULL;
