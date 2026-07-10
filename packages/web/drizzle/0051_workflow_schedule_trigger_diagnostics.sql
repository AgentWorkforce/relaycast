ALTER TABLE "workflow_schedules"
  ADD COLUMN IF NOT EXISTS "last_trigger_status" text,
  ADD COLUMN IF NOT EXISTS "last_trigger_error" text;
