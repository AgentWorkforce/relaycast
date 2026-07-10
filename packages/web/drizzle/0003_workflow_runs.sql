CREATE TABLE "workflow_runs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "sandbox_id" text NOT NULL,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workflow" text NOT NULL,
  "file_type" text NOT NULL,
  "callback_token" text NOT NULL,
  "status" text NOT NULL,
  "result" text,
  "error" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX "idx_workflow_runs_user"
  ON "workflow_runs" ("user_id");
CREATE INDEX "idx_workflow_runs_workspace"
  ON "workflow_runs" ("workspace_id");
CREATE INDEX "idx_workflow_runs_status"
  ON "workflow_runs" ("status");

CREATE TABLE "workflow_steps" (
  "id" uuid PRIMARY KEY NOT NULL,
  "run_id" uuid NOT NULL,
  "step_name" text NOT NULL,
  "agent" text NOT NULL,
  "preset" text NOT NULL,
  "cli" text NOT NULL,
  "sandbox_id" text NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text NOT NULL,
  "duration_ms" integer NOT NULL,
  "exit_code" integer NOT NULL,
  "output_summary" text NOT NULL,
  "error" text
);

CREATE INDEX "idx_workflow_steps_run"
  ON "workflow_steps" ("run_id");
