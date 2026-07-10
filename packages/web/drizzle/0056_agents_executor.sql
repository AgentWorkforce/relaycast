ALTER TABLE "agents" ADD COLUMN "executor" jsonb DEFAULT '{"kind":"ephemeral-sandbox"}'::jsonb NOT NULL;
ALTER TABLE "agents" ADD COLUMN "owner_service" text;
ALTER TABLE "agents" ADD COLUMN "source_tag" text;
CREATE INDEX "idx_agents_owner_service_deployed_name" ON "agents" USING btree ("owner_service","deployed_name");
