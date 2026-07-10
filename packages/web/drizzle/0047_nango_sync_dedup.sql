CREATE TABLE IF NOT EXISTS "nango_sync_dedup" (
	"surface" text NOT NULL,
	"dedupe_id" text NOT NULL,
	"workspace_id" text,
	"provider" text,
	"connection_id" text,
	"provider_config_key" text,
	"sync_name" text,
	"model" text,
	"sync_window_key" text,
	"cursor_key" text,
	"payload_hash" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "nango_sync_dedup_pk" PRIMARY KEY("surface","dedupe_id"),
	CONSTRAINT "nango_sync_dedup_status_check" CHECK ("status" IN ('processing','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nango_sync_dedup_status_lease_idx" ON "nango_sync_dedup" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nango_sync_dedup_workspace_provider_idx" ON "nango_sync_dedup" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nango_sync_dedup_first_seen_idx" ON "nango_sync_dedup" USING btree ("first_seen_at");
