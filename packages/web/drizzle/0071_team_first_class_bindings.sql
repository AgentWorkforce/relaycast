ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "lead_member_name" text;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "delegation" jsonb;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "token_budget" integer;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "time_budget_seconds" integer;
ALTER TABLE "teams" ALTER COLUMN "parent_agent_id" DROP NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "task" DROP NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "shared_mount_root" DROP NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "channel" DROP NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "ttl_seconds" DROP NOT NULL;
ALTER TABLE "teams" ALTER COLUMN "expires_at" DROP NOT NULL;
ALTER TABLE "teams" DROP CONSTRAINT IF EXISTS "teams_status_valid";

ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "persona_ref" jsonb;
ALTER TABLE "team_members" ADD COLUMN IF NOT EXISTS "owns" jsonb;
ALTER TABLE "team_members" ALTER COLUMN "agent_id" DROP NOT NULL;
ALTER TABLE "team_members" ALTER COLUMN "persona_id" DROP NOT NULL;
ALTER TABLE "team_members" DROP CONSTRAINT IF EXISTS "team_members_role_valid";

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_status_valid" CHECK (
    "status" IN ('active', 'starting', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_delegation_array_valid" CHECK (
    "delegation" IS NULL OR jsonb_typeof("delegation") = 'array'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_token_budget_positive" CHECK (
    "token_budget" IS NULL OR "token_budget" > 0
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_time_budget_seconds_positive" CHECK (
    "time_budget_seconds" IS NULL OR "time_budget_seconds" > 0
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_persona_ref_valid" CHECK (
    "persona_ref" IS NULL OR jsonb_typeof("persona_ref") IN ('string', 'object')
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_role_valid" CHECK (
    length(btrim("role")) > 0
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "team_members" ADD CONSTRAINT "team_members_owns_array_valid" CHECK (
    "owns" IS NULL OR jsonb_typeof("owns") = 'array'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
