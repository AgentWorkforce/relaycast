CREATE TABLE IF NOT EXISTS "node_enrollment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE cascade,
  "relay_workspace_id" text NOT NULL,
  "requested_name" text,
  "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "max_agents" integer DEFAULT 0 NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "claim_nonce" text,
  "claimed_at" timestamp with time zone,
  "used_at" timestamp with time zone,
  "used_from_ip" inet,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "node_enrollment_tokens_token_hash_unique"
  ON "node_enrollment_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "idx_node_enrollment_tokens_workspace"
  ON "node_enrollment_tokens" ("workspace_id");

CREATE INDEX IF NOT EXISTS "idx_node_enrollment_tokens_expires_at"
  ON "node_enrollment_tokens" ("expires_at");
