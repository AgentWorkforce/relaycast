CREATE TABLE IF NOT EXISTS "integration_watch_dispatch_failures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "relay_workspace_id" text NOT NULL,
  "provider" text NOT NULL,
  "event_type" text NOT NULL,
  "connection_id" text,
  "delivery_id" text NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status" text DEFAULT 'failed' NOT NULL,
  "reason" text NOT NULL,
  "error" text,
  "occurred_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "integration_watch_dispatch_failures_status_valid"
    CHECK ("status" IN ('failed', 'replayed', 'ignored'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "integration_watch_dispatch_failures_unique"
  ON "integration_watch_dispatch_failures" USING btree (
    "relay_workspace_id",
    "provider",
    "event_type",
    "delivery_id"
  );

CREATE INDEX IF NOT EXISTS "idx_integration_watch_dispatch_failures_reason_created"
  ON "integration_watch_dispatch_failures" USING btree ("reason", "created_at");

CREATE INDEX IF NOT EXISTS "idx_integration_watch_dispatch_failures_relay_workspace"
  ON "integration_watch_dispatch_failures" USING btree ("relay_workspace_id");
