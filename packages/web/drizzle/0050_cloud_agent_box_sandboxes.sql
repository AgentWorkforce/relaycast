ALTER TABLE "sandboxes"
  ADD COLUMN IF NOT EXISTS "cloud_agent_id" uuid;

CREATE INDEX IF NOT EXISTS "idx_sandboxes_workspace_cloud_agent"
  ON "sandboxes" ("workspace_id", "cloud_agent_id", "status");
