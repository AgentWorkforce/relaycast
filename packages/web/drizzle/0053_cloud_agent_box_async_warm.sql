ALTER TABLE "sandboxes"
  ADD COLUMN IF NOT EXISTS "error" text;

ALTER TABLE "sandboxes"
  ADD COLUMN IF NOT EXISTS "expected_ready_by" timestamp with time zone;
