CREATE TABLE IF NOT EXISTS "slack_conversation_threads" (
  "workspace_id" text NOT NULL,
  "channel" text NOT NULL,
  "thread_ts" text NOT NULL,
  "deployed_name" text NOT NULL,
  "agent_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspace_id", "channel", "thread_ts")
);
