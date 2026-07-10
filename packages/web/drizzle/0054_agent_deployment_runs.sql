CREATE TABLE IF NOT EXISTS "agent_deployment_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deployment_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "event_source" text NOT NULL DEFAULT 'unknown',
  "sandbox_id" text,
  "sandbox_name" text,
  "stdout" text NOT NULL DEFAULT '',
  "stdout_truncated" boolean NOT NULL DEFAULT false,
  "stderr" text NOT NULL DEFAULT '',
  "stderr_truncated" boolean NOT NULL DEFAULT false,
  "mount_log_tail" text NOT NULL DEFAULT '',
  "exit_code" integer,
  "cleanup_status" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_ms" integer NOT NULL DEFAULT 0,
  "status" text NOT NULL,
  "error" text,
  "summary" text,
  "compressed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "agent_deployment_runs"
    ADD CONSTRAINT "agent_deployment_runs_deployment_id_agent_deployments_id_fk"
    FOREIGN KEY ("deployment_id")
    REFERENCES "agent_deployments"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_deployment_runs"
    ADD CONSTRAINT "agent_deployment_runs_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id")
    REFERENCES "agents"("id")
    ON DELETE CASCADE
    ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_agent_deployment_runs_agent_started"
  ON "agent_deployment_runs" USING btree ("agent_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_deployment_runs_deployment_started"
  ON "agent_deployment_runs" USING btree ("deployment_id", "started_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_agent_deployment_runs_status"
  ON "agent_deployment_runs" USING btree ("status");

CREATE INDEX IF NOT EXISTS "idx_agent_deployment_runs_compressed_at"
  ON "agent_deployment_runs" USING btree ("compressed_at");
