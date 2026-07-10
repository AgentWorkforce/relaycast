CREATE TABLE IF NOT EXISTS "slack_channel_configs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "slack_channel_id" varchar(255) NOT NULL,
  "slack_channel_name" varchar(255),
  "is_private" boolean NOT NULL DEFAULT false,
  "is_enabled" boolean NOT NULL DEFAULT true,
  "metadata_json" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "slack_channel_configs_provider_check"
    CHECK ("provider" IN ('slack-sage','slack-my-senior-dev','slack-nightcto')),
  CONSTRAINT "slack_channel_configs_workspace_provider_channel_unique"
    UNIQUE ("workspace_id","provider","slack_channel_id")
);

CREATE INDEX IF NOT EXISTS "idx_slack_channel_configs_workspace_provider"
  ON "slack_channel_configs" ("workspace_id","provider");
