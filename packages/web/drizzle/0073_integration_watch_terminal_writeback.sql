ALTER TABLE "integration_watch_deliveries"
  ADD COLUMN IF NOT EXISTS "terminal_writeback_status" text,
  ADD COLUMN IF NOT EXISTS "terminal_writeback_posted_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "terminal_writeback_error" text;
