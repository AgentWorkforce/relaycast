CREATE TABLE IF NOT EXISTS "deployment_tick_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "delivery_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "lease_until" timestamp with time zone,
  "provisioning_sandbox_id" text,
  "run_deployment_id" uuid,
  "run_sandbox_id" text,
  "run_session_id" text,
  "run_command_id" text,
  "run_started_at" timestamp with time zone,
  "run_sandbox_name" text,
  "run_mount_configured" boolean,
  "last_error" text,
  "delivered_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "deployment_tick_deliveries_status_check"
    CHECK ("status" IN ('pending','processing','running','delivered','failed'))
);

DO $$ BEGIN
  ALTER TABLE "deployment_tick_deliveries"
    ADD CONSTRAINT "deployment_tick_deliveries_workspace_id_workspaces_id_fk"
    FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "deployment_tick_deliveries"
    ADD CONSTRAINT "deployment_tick_deliveries_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id")
    REFERENCES "agents"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "deployment_tick_deliveries_delivery_unique"
  ON "deployment_tick_deliveries" USING btree ("workspace_id","agent_id","delivery_id");

CREATE INDEX IF NOT EXISTS "idx_deployment_tick_deliveries_pending"
  ON "deployment_tick_deliveries" USING btree ("workspace_id","agent_id","status","next_attempt_at");

CREATE INDEX IF NOT EXISTS "idx_deployment_tick_deliveries_status_lease"
  ON "deployment_tick_deliveries" USING btree ("status","lease_until");
