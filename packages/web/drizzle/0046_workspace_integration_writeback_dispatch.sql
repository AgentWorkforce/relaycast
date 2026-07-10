ALTER TABLE "workspace_integrations"
  ADD COLUMN IF NOT EXISTS "writeback_dispatch_via" text NOT NULL DEFAULT 'bridge';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'workspace_integrations_writeback_dispatch_via_check'
      AND conrelid = 'workspace_integrations'::regclass
  ) THEN
    ALTER TABLE "workspace_integrations"
      ADD CONSTRAINT "workspace_integrations_writeback_dispatch_via_check"
      CHECK ("writeback_dispatch_via" IN ('bridge', 'cf'));
  END IF;
END $$;
