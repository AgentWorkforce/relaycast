CREATE TABLE IF NOT EXISTS "slack_direct_proxy_writeback_idempotency" (
  "workspace_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "provider_config_key" text NOT NULL,
  "connection_id" text NOT NULL,
  "status" text NOT NULL,
  "op_id" text,
  "slack_ts" text,
  "metadata" jsonb,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "slack_direct_proxy_writeback_idempotency_pk"
    PRIMARY KEY ("workspace_id","idempotency_key"),
  CONSTRAINT "slack_direct_proxy_writeback_idempotency_status_check"
    CHECK ("status" IN ('pending','success','permanent_failure'))
);

CREATE INDEX IF NOT EXISTS "slack_direct_proxy_writeback_idempotency_expires_idx"
  ON "slack_direct_proxy_writeback_idempotency" USING btree ("expires_at");
