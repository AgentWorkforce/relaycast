CREATE TABLE IF NOT EXISTS "relayfile_writeback_receipts" (
  "workspace_id" text NOT NULL,
  "op_id" text NOT NULL,
  "provider" text NOT NULL,
  "outcome" text NOT NULL,
  "error_code" text,
  "error_message" text,
  "metadata" jsonb,
  "acked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  CONSTRAINT "relayfile_writeback_receipts_pk" PRIMARY KEY ("workspace_id","op_id"),
  CONSTRAINT "relayfile_writeback_receipts_outcome_check"
    CHECK ("outcome" IN ('success','permanent_failure'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relayfile_writeback_receipts_expires_idx"
  ON "relayfile_writeback_receipts" USING btree ("expires_at");
