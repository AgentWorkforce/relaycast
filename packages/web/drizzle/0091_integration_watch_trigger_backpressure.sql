ALTER TABLE "agents" ADD COLUMN "delivery_max_concurrency_by_trigger" jsonb;

ALTER TABLE "integration_watch_deliveries" ADD COLUMN "trigger_key" text;

CREATE INDEX IF NOT EXISTS "idx_integration_watch_deliveries_agent_trigger_status"
  ON "integration_watch_deliveries" USING btree ("agent_id","status","next_attempt_at","trigger_key");
