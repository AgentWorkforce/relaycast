CREATE TABLE IF NOT EXISTS "pr_sandbox_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer NOT NULL,
	"sandbox_id" text,
	"sandbox_name" text NOT NULL,
	"state" text DEFAULT 'warm' NOT NULL,
	"lease_until" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"current_step" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pr_sandbox_leases_workspace_agent_repo_pr_unique" ON "pr_sandbox_leases" USING btree ("workspace_id","agent_id","repo_full_name","pr_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_sandbox_leases_state_last_used" ON "pr_sandbox_leases" USING btree ("state","last_used_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pr_sandbox_leases_state_lease" ON "pr_sandbox_leases" USING btree ("state","lease_until");
