CREATE TABLE "ricky_slack_gate_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gate_id" uuid NOT NULL,
	"ricky_run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"message_ts" text NOT NULL,
	"thread_ts" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ricky_slack_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_enterprise_id" text,
	"bot_user_id" text,
	"connection_id" text NOT NULL,
	"provider_config_key" text,
	"installed_by_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ricky_slack_run_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ricky_run_id" uuid NOT NULL,
	"root_workflow_run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"created_by_slack_user_id" text NOT NULL,
	"notify_policy_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ricky_slack_user_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"cloud_user_id" uuid NOT NULL,
	"slack_team_id" text NOT NULL,
	"slack_user_id" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_slack_gate_messages_gate_unique" ON "ricky_slack_gate_messages" USING btree ("gate_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_gate_messages_ricky_run" ON "ricky_slack_gate_messages" USING btree ("ricky_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_gate_messages_slack_message" ON "ricky_slack_gate_messages" USING btree ("slack_team_id","channel_id","message_ts");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_installations_workspace" ON "ricky_slack_installations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_installations_team" ON "ricky_slack_installations" USING btree ("slack_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_slack_installations_team_workspace_unique" ON "ricky_slack_installations" USING btree ("slack_team_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_slack_run_threads_ricky_run_unique" ON "ricky_slack_run_threads" USING btree ("ricky_run_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_run_threads_workspace" ON "ricky_slack_run_threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_run_threads_slack_thread" ON "ricky_slack_run_threads" USING btree ("slack_team_id","channel_id","thread_ts");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_user_links_cloud_user" ON "ricky_slack_user_links" USING btree ("cloud_user_id");--> statement-breakpoint
CREATE INDEX "idx_ricky_slack_user_links_slack_identity" ON "ricky_slack_user_links" USING btree ("slack_team_id","slack_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_slack_user_links_identity_workspace_unique" ON "ricky_slack_user_links" USING btree ("slack_team_id","slack_user_id","workspace_id");