CREATE TABLE IF NOT EXISTS "workspace_integrations" (
  "workspace_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "connection_id" text NOT NULL,
  "provider_config_key" text,
  "installation_id" text,
  "metadata_json" text DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "workspace_integrations_workspace_id_provider_pk" PRIMARY KEY("workspace_id","provider")
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_integrations_provider_connection_unique"
  ON "workspace_integrations" ("provider", "connection_id");

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_integrations_provider_installation_unique"
  ON "workspace_integrations" ("provider", "installation_id");
