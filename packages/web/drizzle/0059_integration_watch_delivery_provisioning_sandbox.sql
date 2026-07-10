ALTER TABLE "integration_watch_deliveries"
  ADD COLUMN IF NOT EXISTS "provisioning_sandbox_id" text;
