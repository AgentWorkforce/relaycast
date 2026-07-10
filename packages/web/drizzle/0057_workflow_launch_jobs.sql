CREATE TABLE IF NOT EXISTS "workflow_launch_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "lease_until" timestamp with time zone,
  "sandbox_id" text,
  "relay_workspace_id" text,
  "request_envelope" jsonb NOT NULL,
  "last_error" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_launch_jobs_run_unique" ON "workflow_launch_jobs" USING btree ("run_id");
CREATE INDEX IF NOT EXISTS "idx_workflow_launch_jobs_status_lease" ON "workflow_launch_jobs" USING btree ("status","lease_until");
CREATE INDEX IF NOT EXISTS "idx_workflow_launch_jobs_workspace" ON "workflow_launch_jobs" USING btree ("workspace_id");
