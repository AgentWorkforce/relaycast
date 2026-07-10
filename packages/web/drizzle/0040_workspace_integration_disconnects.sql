CREATE TABLE "workspace_integration_disconnects" (
	"workspace_id" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_config_key" text,
	"disconnected_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_integration_disconnects_workspace_id_provider_connection_id_pk" PRIMARY KEY("workspace_id","provider","connection_id")
);
--> statement-breakpoint
CREATE INDEX "idx_workspace_integration_disconnects_workspace_provider" ON "workspace_integration_disconnects" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX "idx_workspace_integration_disconnects_expires_at" ON "workspace_integration_disconnects" USING btree ("expires_at");