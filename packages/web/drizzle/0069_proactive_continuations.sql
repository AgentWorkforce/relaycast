CREATE TABLE IF NOT EXISTS "proactive_continuations" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text,
  "status" text NOT NULL,
  "wait_for_type" text NOT NULL,
  "correlation" text,
  "record" jsonb NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_proactive_continuations_session_id"
  ON "proactive_continuations" USING btree ("session_id");

CREATE INDEX IF NOT EXISTS "idx_proactive_continuations_wait_for_type"
  ON "proactive_continuations" USING btree ("wait_for_type");

CREATE INDEX IF NOT EXISTS "idx_proactive_continuations_correlation"
  ON "proactive_continuations" USING btree ("correlation");
