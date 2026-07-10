CREATE TABLE "ricky_linear_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"linear_org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_config_key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"installed_by_cloud_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_linear_installations_workspace_unique" ON "ricky_linear_installations" USING btree ("workspace_id");
