CREATE TABLE "api_token_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_family_id" uuid NOT NULL,
  "subject_type" text NOT NULL,
  "user_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "sandbox_id" text,
  "run_id" uuid,
  "scopes" text NOT NULL,
  "access_token_hash" text NOT NULL,
  "access_token_expires_at" timestamp with time zone NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "refresh_token_expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "last_used_at" timestamp with time zone,
  "last_refreshed_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "revoked_reason" text
);

CREATE UNIQUE INDEX "api_token_sessions_access_hash_unique"
  ON "api_token_sessions" ("access_token_hash");
CREATE UNIQUE INDEX "api_token_sessions_refresh_hash_unique"
  ON "api_token_sessions" ("refresh_token_hash");
CREATE INDEX "idx_api_token_sessions_family" ON "api_token_sessions" ("token_family_id");
CREATE INDEX "idx_api_token_sessions_user" ON "api_token_sessions" ("user_id");
CREATE INDEX "idx_api_token_sessions_run" ON "api_token_sessions" ("run_id");
CREATE INDEX "idx_api_token_sessions_sandbox" ON "api_token_sessions" ("sandbox_id");
