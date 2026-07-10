CREATE TABLE "ricky_linear_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cloud_user_id" uuid NOT NULL,
	"linear_org_id" text NOT NULL,
	"linear_user_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ricky_linear_user_links_identity_workspace_unique" ON "ricky_linear_user_links" USING btree ("linear_org_id","linear_user_id","workspace_id");--> statement-breakpoint
CREATE INDEX "ricky_linear_user_links_cloud_user_idx" ON "ricky_linear_user_links" USING btree ("cloud_user_id");
