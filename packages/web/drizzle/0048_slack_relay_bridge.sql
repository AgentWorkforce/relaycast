DO $$
BEGIN
  CREATE TYPE "slack_relay_message_direction" AS ENUM ('slack_to_relay', 'relay_to_slack');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_relay_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" text NOT NULL REFERENCES "relay_workspaces"("id") ON DELETE CASCADE,
  "slack_channel_id" text NOT NULL,
  "relay_channel_id" text NOT NULL,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "slack_relay_links_workspace_slack_relay_unique"
    UNIQUE ("workspace_id", "slack_channel_id", "relay_channel_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_relay_links_workspace"
  ON "slack_relay_links" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_relay_links_slack_channel"
  ON "slack_relay_links" ("slack_channel_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_relay_messages" (
  "seq" bigserial PRIMARY KEY,
  "link_id" uuid NOT NULL REFERENCES "slack_relay_links"("id") ON DELETE CASCADE,
  "direction" "slack_relay_message_direction" NOT NULL,
  "slack_ts" text NOT NULL,
  "relay_message_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "slack_relay_messages_link_slack_direction_unique"
    UNIQUE ("link_id", "slack_ts", "direction")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_relay_messages_slack_ts"
  ON "slack_relay_messages" ("slack_ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_relay_messages_relay_message_id"
  ON "slack_relay_messages" ("relay_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_relay_messages_link_seq"
  ON "slack_relay_messages" ("link_id", "seq");
