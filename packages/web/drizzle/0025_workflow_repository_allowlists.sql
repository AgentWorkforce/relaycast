CREATE TABLE "workflow_repository_allowlists" (
	"workspace_id" uuid NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"installation_id" text NOT NULL,
	"push_allowed" boolean DEFAULT false NOT NULL,
	"allowed_at" timestamp with time zone NOT NULL,
	"allowed_by" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_repository_allowlists" ADD CONSTRAINT "workflow_repository_allowlists_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_repository_allowlists_workspace_repo_unique" ON "workflow_repository_allowlists" USING btree ("workspace_id","repo_owner","repo_name");--> statement-breakpoint
CREATE INDEX "idx_workflow_repository_allowlists_workspace" ON "workflow_repository_allowlists" USING btree ("workspace_id");