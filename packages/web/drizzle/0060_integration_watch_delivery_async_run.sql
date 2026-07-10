ALTER TABLE "integration_watch_deliveries"
  ADD COLUMN IF NOT EXISTS "run_deployment_id" uuid,
  ADD COLUMN IF NOT EXISTS "run_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "run_session_id" text,
  ADD COLUMN IF NOT EXISTS "run_command_id" text,
  ADD COLUMN IF NOT EXISTS "run_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "run_sandbox_name" text,
  ADD COLUMN IF NOT EXISTS "run_mount_configured" boolean;

ALTER TABLE "integration_watch_deliveries"
  DROP CONSTRAINT IF EXISTS "integration_watch_deliveries_status_check";

ALTER TABLE "integration_watch_deliveries"
  ADD CONSTRAINT "integration_watch_deliveries_status_check"
  CHECK ("status" IN ('pending','processing','running','delivered','failed')) NOT VALID;
