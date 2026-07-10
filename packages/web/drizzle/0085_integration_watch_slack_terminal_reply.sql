ALTER TABLE "integration_watch_deliveries"
  ADD COLUMN IF NOT EXISTS "slack_terminal_reply_status" text,
  ADD COLUMN IF NOT EXISTS "slack_terminal_reply_posted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "slack_terminal_reply_error" text;
