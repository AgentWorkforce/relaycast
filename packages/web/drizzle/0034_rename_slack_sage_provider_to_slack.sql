-- Rename the slack relayfile integration's stored provider id from the
-- legacy `slack-sage` to `slack`, completing the partial rename that left
-- `defaultConfigKey: "slack-relay"` and `id: "slack-sage"` diverging in
-- packages/web/lib/integrations/providers.ts. The `slack-sage` value is
-- retained as a backwards-compat alias in the providers map so any
-- in-flight tokens or external integrations still resolve.
--
-- Tables to migrate:
--   * workspace_integrations.provider — keyed (workspace_id, provider).
--     A workspace might already have a `slack` row alongside a
--     `slack-sage` row (e.g. someone reconnected post-rename in a code
--     branch), so we use a "delete the legacy row if a canonical row
--     already exists" ON CONFLICT branch to avoid PK violations.
--   * slack_channel_configs.provider — channel-level fanout config rows
--     reference the same provider id; bring them along so post-migration
--     channel queries (which now key on `slack`) keep finding their
--     existing config rows.
--
-- The migration is idempotent: re-running is a no-op once `slack-sage`
-- rows have already been migrated.

-- 1. workspace_integrations
--    PK is (workspace_id, provider). If a (workspace_id, 'slack') row
--    already exists, drop the legacy `slack-sage` row to keep the newer
--    one. Otherwise rename the legacy row's provider to `slack`.
DELETE FROM "workspace_integrations" old
WHERE old."provider" = 'slack-sage'
  AND EXISTS (
    SELECT 1
    FROM "workspace_integrations" new
    WHERE new."workspace_id" = old."workspace_id"
      AND new."provider" = 'slack'
  );
--> statement-breakpoint

UPDATE "workspace_integrations"
SET "provider" = 'slack'
WHERE "provider" = 'slack-sage';
--> statement-breakpoint

-- 2. slack_channel_configs
--    The unique index is (workspace_id, provider, slack_channel_id).
--    Same collision-handling shape: keep the canonical `slack` row if
--    one already exists, otherwise rename the legacy row.
--
--    PRE-WORK: drop the existing slack_channel_configs_provider_check
--    CHECK constraint (created in 0015_slack_channel_configs.sql with
--    a hardcoded list that does NOT include 'slack'). Without this drop
--    the UPDATE below fails with `new row for relation
--    "slack_channel_configs" violates check constraint
--    "slack_channel_configs_provider_check"`. We recreate the constraint
--    afterwards with the new list.
ALTER TABLE "slack_channel_configs"
  DROP CONSTRAINT IF EXISTS "slack_channel_configs_provider_check";
--> statement-breakpoint

DELETE FROM "slack_channel_configs" old
WHERE old."provider" = 'slack-sage'
  AND EXISTS (
    SELECT 1
    FROM "slack_channel_configs" new
    WHERE new."workspace_id" = old."workspace_id"
      AND new."provider" = 'slack'
      AND new."slack_channel_id" = old."slack_channel_id"
  );
--> statement-breakpoint

UPDATE "slack_channel_configs"
SET "provider" = 'slack'
WHERE "provider" = 'slack-sage';
--> statement-breakpoint

ALTER TABLE "slack_channel_configs"
  ADD CONSTRAINT "slack_channel_configs_provider_check"
  CHECK ("provider" IN ('slack', 'slack-sage', 'slack-my-senior-dev', 'slack-nightcto'));
