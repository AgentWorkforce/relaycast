CREATE TABLE IF NOT EXISTS "workspace_digest_functions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "display_name" text,
  "status" text DEFAULT 'active' NOT NULL,
  CONSTRAINT "workspace_digest_functions_status_valid" CHECK ("status" IN ('active', 'disabled')),
  "runtime" text DEFAULT 'node20' NOT NULL,
  "entrypoint" text NOT NULL,
  "source_hash" text NOT NULL,
  "source_size" integer NOT NULL,
  "compiled_artifact_ref" text NOT NULL,
  "signature" text NOT NULL,
  "signing_key_id" text NOT NULL,
  "deployed_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "disabled_at" timestamp with time zone,
  "disabled_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "last_invoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_digest_functions_workspace_slug_live_unique"
  ON "workspace_digest_functions" USING btree ("workspace_id", "slug")
  WHERE "status" != 'disabled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_digest_functions_workspace_status"
  ON "workspace_digest_functions" USING btree ("workspace_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workspace_digest_functions_source_hash"
  ON "workspace_digest_functions" USING btree ("source_hash");
