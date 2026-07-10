CREATE TABLE IF NOT EXISTS "teams" (
  "id" text PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "parent_agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "parent_deployment_id" uuid REFERENCES "agent_deployments"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'starting',
  "task" text NOT NULL,
  "team_prompt" text,
  "shared_mount_root" text NOT NULL,
  "channel" text NOT NULL,
  "ttl_seconds" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "summary" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "teams_status_valid" CHECK (
    "status" IN ('starting', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS "idx_teams_workspace_status" ON "teams" ("workspace_id", "status");
CREATE INDEX IF NOT EXISTS "idx_teams_parent_agent" ON "teams" ("parent_agent_id");
CREATE INDEX IF NOT EXISTS "idx_teams_expires_at" ON "teams" ("expires_at");

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "persona_id" text NOT NULL,
  "role" text NOT NULL DEFAULT 'worker',
  "sandbox_id" text,
  "assigned_task" text,
  "status" text NOT NULL DEFAULT 'starting',
  "result_id" text,
  "output" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "team_members_role_valid" CHECK (
    "role" IN ('orchestrator', 'worker', 'reviewer')
  ),
  CONSTRAINT "team_members_status_valid" CHECK (
    "status" IN ('starting', 'running', 'succeeded', 'failed', 'timed_out')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_team_name_unique" ON "team_members" ("team_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "team_members_team_orchestrator_unique" ON "team_members" ("team_id") WHERE "role" = 'orchestrator';
CREATE INDEX IF NOT EXISTS "idx_team_members_team" ON "team_members" ("team_id");
CREATE INDEX IF NOT EXISTS "idx_team_members_agent" ON "team_members" ("agent_id");

CREATE TABLE IF NOT EXISTS "team_events" (
  "id" text PRIMARY KEY NOT NULL,
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "member_name" text,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_team_events_team_created" ON "team_events" ("team_id", "created_at");
