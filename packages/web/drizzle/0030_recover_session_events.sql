-- Recovery for session_events (originally created in 0020_session_events.sql).
--
-- Why: 0020 was committed with `"when": 1776853464134` — smaller than
-- 0019_platform's `1777800100000`. drizzle-kit's migrate filter is
-- `lastDbMigration.created_at < migration.folderMillis`; once 0019
-- ran on prod and stamped its `created_at`, drizzle compared
-- `1777800100000 < 1776853464134` → false and silently skipped 0020.
-- Confirmed missing on prod by the post-migrate `db:verify-schema`
-- gate (#421/#429).
--
-- This migration is intentionally idempotent — `CREATE TABLE
-- IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` everywhere — so it
-- is safe whether 0020 actually applied (locally or on PR previews)
-- or was silently skipped (prod). Mirror 0020's DDL exactly so the
-- resulting schema is byte-identical regardless of which path
-- created the rows.
--
-- Journal `when` is set strictly greater than every prior entry so
-- this migration is NOT subject to the same filter bug. Enforced by
-- tests/web-drizzle-journal.test.ts.

CREATE TABLE IF NOT EXISTS "session_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"step_name" text,
	"sandbox_id" text,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "session_events_run_sequence_unique" ON "session_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_events_run" ON "session_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_events_type" ON "session_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_session_events_created_at" ON "session_events" USING btree ("created_at");
