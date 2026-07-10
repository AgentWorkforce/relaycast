ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "inbox_selectors" text[];

CREATE INDEX IF NOT EXISTS "idx_agents_workspace_inbox_selectors"
  ON "agents" USING gin ("inbox_selectors");
