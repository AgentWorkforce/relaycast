ALTER TABLE "workflow_runs" ALTER COLUMN "sandbox_id" DROP NOT NULL;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "dispatch_type" text NOT NULL DEFAULT 'sandbox';

CREATE TABLE IF NOT EXISTS "workers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "display_name" text NOT NULL,
  "host_info" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "token_hash" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "last_seen" timestamptz,
  "registered_at" timestamptz NOT NULL DEFAULT now(),
  "registered_by" uuid NOT NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT "workers_workspace_name_unique" UNIQUE("workspace_id", "name")
);

CREATE INDEX IF NOT EXISTS "workers_workspace" ON "workers"("workspace_id");
CREATE INDEX IF NOT EXISTS "workers_status" ON "workers"("status") WHERE "status" != 'revoked';

CREATE TABLE IF NOT EXISTS "worker_enrollment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "token_hash" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "created_by" uuid NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "used_from_ip" inet,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "worker_enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);

CREATE TABLE IF NOT EXISTS "work_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "worker_id" uuid REFERENCES "workers"("id") ON DELETE SET NULL,
  "run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE CASCADE,
  "workflow_ref" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'queued',
  "queued_at" timestamptz NOT NULL DEFAULT now(),
  "assigned_at" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "queue_deadline" timestamptz NOT NULL,
  "result" jsonb,
  "error" text,
  CONSTRAINT "work_assignments_run_id_unique" UNIQUE("run_id")
);

CREATE INDEX IF NOT EXISTS "work_assignments_worker" ON "work_assignments"("worker_id") WHERE "status" IN ('assigned', 'running');
CREATE INDEX IF NOT EXISTS "work_assignments_queued" ON "work_assignments"("workspace_id", "status") WHERE "status" = 'queued';
