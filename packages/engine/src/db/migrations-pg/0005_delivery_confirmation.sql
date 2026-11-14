ALTER TABLE "deliveries" ADD COLUMN "accepted_at" bigint;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "replied_at" bigint;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "reply_message_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" text;