CREATE TABLE "ricky_webhook_dedup" (
	"surface" text NOT NULL,
	"delivery_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ricky_webhook_dedup_pk" PRIMARY KEY("surface","delivery_id")
);
--> statement-breakpoint
CREATE INDEX "ricky_webhook_dedup_expires_idx" ON "ricky_webhook_dedup" USING btree ("expires_at");
