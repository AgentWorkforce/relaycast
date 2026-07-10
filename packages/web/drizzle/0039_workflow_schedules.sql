CREATE TABLE "workflow_schedules" (
  "id" uuid PRIMARY KEY NOT NULL,
  "relaycron_schedule_id" text NOT NULL,
  "relaycron_api_key_envelope" jsonb NOT NULL,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "schedule_type" text NOT NULL,
  "cron_expression" text,
  "scheduled_at" timestamp with time zone,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "workflow_request_envelope" jsonb NOT NULL,
  "webhook_secret_hash" text NOT NULL,
  "last_triggered_run_id" uuid,
  "last_triggered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "workflow_schedules_relaycron_schedule_unique"
  ON "workflow_schedules" USING btree ("relaycron_schedule_id");
CREATE INDEX "idx_workflow_schedules_user"
  ON "workflow_schedules" USING btree ("user_id");
CREATE INDEX "idx_workflow_schedules_workspace"
  ON "workflow_schedules" USING btree ("workspace_id");
CREATE INDEX "idx_workflow_schedules_organization"
  ON "workflow_schedules" USING btree ("organization_id");
CREATE INDEX "idx_workflow_schedules_status"
  ON "workflow_schedules" USING btree ("status");
