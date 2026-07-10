CREATE TABLE "cli_auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "sandbox_id" text NOT NULL,
  "provider" text NOT NULL,
  "language" text NOT NULL,
  "home" text NOT NULL,
  "user_id" uuid NOT NULL,
  "daytona_api_key" text,
  "daytona_jwt_token" text,
  "daytona_organization_id" text,
  "ssh_token" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "cli_auth_sessions_sandbox_unique"
  ON "cli_auth_sessions" ("sandbox_id");
CREATE INDEX "idx_cli_auth_sessions_user"
  ON "cli_auth_sessions" ("user_id");
CREATE INDEX "idx_cli_auth_sessions_expires_at"
  ON "cli_auth_sessions" ("expires_at");
