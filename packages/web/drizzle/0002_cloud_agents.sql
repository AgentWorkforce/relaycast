CREATE TABLE "cloud_agents" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "harness" text NOT NULL,
  "display_name" text NOT NULL,
  "default_model" text,
  "status" text NOT NULL,
  "credential_stored_at" timestamp with time zone,
  "last_authenticated_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE INDEX "idx_cloud_agents_workspace_user"
  ON "cloud_agents" ("workspace_id", "user_id");

CREATE TABLE "cloud_agent_auth_sessions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "cloud_agent_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "workspace_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "harness" text NOT NULL,
  "status" text NOT NULL,
  "language" text NOT NULL,
  "sandbox_id" text NOT NULL,
  "remote_command" text,
  "started_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "canceled_at" timestamp with time zone,
  "credential_stored_at" timestamp with time zone,
  "failure_reason" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

CREATE UNIQUE INDEX "cloud_agent_auth_sessions_sandbox_unique"
  ON "cloud_agent_auth_sessions" ("sandbox_id");
CREATE INDEX "idx_cloud_agent_auth_sessions_cloud_agent"
  ON "cloud_agent_auth_sessions" ("cloud_agent_id");
CREATE INDEX "idx_cloud_agent_auth_sessions_user_status"
  ON "cloud_agent_auth_sessions" ("user_id", "status");
CREATE INDEX "idx_cloud_agent_auth_sessions_expires_at"
  ON "cloud_agent_auth_sessions" ("expires_at");
