ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "cloud_agent_spawn_quota_override" integer;

ALTER TABLE "users"
  DROP CONSTRAINT IF EXISTS "users_cloud_agent_spawn_quota_override_positive";

ALTER TABLE "users"
  ADD CONSTRAINT "users_cloud_agent_spawn_quota_override_positive"
  CHECK (
    "cloud_agent_spawn_quota_override" IS NULL
    OR "cloud_agent_spawn_quota_override" > 0
  );
