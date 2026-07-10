CREATE TABLE "ricky_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ricky_run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"previous_workflow_run_id" uuid,
	"start_from_step" text,
	"role" text NOT NULL,
	"repair_mode" text,
	"repair_agent_json" jsonb,
	"diagnosis_json" jsonb,
	"evidence_snapshot_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repair_summary" text,
	"repaired_workflow_path" text,
	"repaired_workflow_digest" text,
	"repaired_artifact_json" jsonb,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ricky_human_gates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ricky_run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"workflow_run_id" uuid,
	"gate_type" text NOT NULL,
	"reason" text NOT NULL,
	"prompt" text NOT NULL,
	"proposed_action_json" jsonb,
	"status" text NOT NULL,
	"requested_by_agent_json" jsonb,
	"resolved_by_user_id" uuid,
	"resolution_json" jsonb,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ricky_run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ricky_run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ricky_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"root_workflow_run_id" uuid NOT NULL,
	"active_workflow_run_id" uuid,
	"status" text NOT NULL,
	"max_attempts" integer NOT NULL,
	"current_attempt" integer NOT NULL,
	"source_workflow_path" text,
	"source_file_type" text NOT NULL,
	"runtime_json" jsonb,
	"auto_fix_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"selected_agent_json" jsonb,
	"latest_diagnosis_json" jsonb,
	"final_result_json" jsonb,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_attempts_run_attempt_unique" ON "ricky_attempts" USING btree ("ricky_run_id","attempt");--> statement-breakpoint
CREATE INDEX "idx_ricky_attempts_ricky_run" ON "ricky_attempts" USING btree ("ricky_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_attempts_workflow_run" ON "ricky_attempts" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_attempts_status" ON "ricky_attempts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_ricky_human_gates_ricky_run" ON "ricky_human_gates" USING btree ("ricky_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_human_gates_attempt" ON "ricky_human_gates" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_human_gates_status" ON "ricky_human_gates" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_run_events_run_sequence_unique" ON "ricky_run_events" USING btree ("ricky_run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_ricky_run_events_ricky_run" ON "ricky_run_events" USING btree ("ricky_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_run_events_type" ON "ricky_run_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_ricky_run_events_created_at" ON "ricky_run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_ricky_runs_workspace" ON "ricky_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_runs_user" ON "ricky_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_runs_root_workflow_run" ON "ricky_runs" USING btree ("root_workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_runs_active_workflow_run" ON "ricky_runs" USING btree ("active_workflow_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_runs_status" ON "ricky_runs" USING btree ("status");