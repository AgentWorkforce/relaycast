CREATE TABLE IF NOT EXISTS "relay_file_access_revocations" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"scope" text DEFAULT 'relayfile-access' NOT NULL,
	"workspace" text,
	"agent_name" text,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relay_file_access_revocations_expires_at" ON "relay_file_access_revocations" USING btree ("expires_at");
