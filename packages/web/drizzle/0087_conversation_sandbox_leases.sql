CREATE TABLE IF NOT EXISTS "conversation_sandbox_leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text NOT NULL,
	"deployment_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_key" text NOT NULL,
	"harness_session_id" text NOT NULL,
	"sandbox_id" text,
	"sandbox_name" text NOT NULL,
	"state" text DEFAULT 'warm' NOT NULL,
	"lease_until" timestamp with time zone,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"current_step" text,
	"snapshot_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_sandbox_leases_workspace_agent_conversation_unique" ON "conversation_sandbox_leases" USING btree ("workspace_id","agent_id","conversation_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_sandbox_leases_state_last_used" ON "conversation_sandbox_leases" USING btree ("state","last_used_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_sandbox_leases_state_lease" ON "conversation_sandbox_leases" USING btree ("state","lease_until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_conversation_sandbox_leases_workspace_state" ON "conversation_sandbox_leases" USING btree ("workspace_id","state");
