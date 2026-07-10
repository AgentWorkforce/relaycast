CREATE TABLE IF NOT EXISTS "integration_watch_issue_dispatch_dedup" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "issue_key" text NOT NULL,
  "agent_id" uuid NOT NULL,
  "delivery_id" text NOT NULL,
  "claimed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "integration_watch_issue_dispatch_dedup"
    ADD CONSTRAINT "integration_watch_issue_dispatch_dedup_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "integration_watch_issue_dispatch_dedup"
    ADD CONSTRAINT "integration_watch_issue_dispatch_dedup_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id")
    REFERENCES "agents"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "integration_watch_issue_dispatch_dedup_unique"
  ON "integration_watch_issue_dispatch_dedup" USING btree ("workspace_id","issue_key","agent_id");

