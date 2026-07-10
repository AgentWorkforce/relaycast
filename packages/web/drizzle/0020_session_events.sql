CREATE TABLE "session_events" (
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
CREATE UNIQUE INDEX "session_events_run_sequence_unique" ON "session_events" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_session_events_run" ON "session_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_session_events_type" ON "session_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "idx_session_events_created_at" ON "session_events" USING btree ("created_at");