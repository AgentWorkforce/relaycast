CREATE TABLE IF NOT EXISTS "sandboxes" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "source" text NOT NULL,
  "run_id" uuid,
  "status" text NOT NULL,
  "broker_port" integer,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_sandboxes_user"
  ON "sandboxes" ("user_id");
