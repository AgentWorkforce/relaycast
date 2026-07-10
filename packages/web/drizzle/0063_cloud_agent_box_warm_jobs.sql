CREATE TABLE IF NOT EXISTS "cloud_agent_box_warm_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cloud_agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"sandbox_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"current_step" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cloud_agent_box_warm_jobs_workspace_cloud_agent" ON "cloud_agent_box_warm_jobs" USING btree ("workspace_id","cloud_agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_cloud_agent_box_warm_jobs_status_lease" ON "cloud_agent_box_warm_jobs" USING btree ("status","lease_until");--> statement-breakpoint
ALTER TABLE "sandboxes" ADD COLUMN IF NOT EXISTS "active_warm_job_id" uuid;--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'sandboxes_active_warm_job_id_cloud_agent_box_warm_jobs_id_fk'
	) THEN
		ALTER TABLE "sandboxes"
			ADD CONSTRAINT "sandboxes_active_warm_job_id_cloud_agent_box_warm_jobs_id_fk"
			FOREIGN KEY ("active_warm_job_id") REFERENCES "public"."cloud_agent_box_warm_jobs"("id")
			ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
