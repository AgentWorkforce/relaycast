ALTER TABLE "sandboxes"
  ADD COLUMN IF NOT EXISTS "keepalive_until" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_sandboxes_cloud_agent_keepalive"
  ON "sandboxes" ("keepalive_until")
  WHERE "source" = 'cloud-agent'
    AND "cloud_agent_id" IS NOT NULL
    AND "status" = 'running'
    AND "keepalive_until" IS NOT NULL;
