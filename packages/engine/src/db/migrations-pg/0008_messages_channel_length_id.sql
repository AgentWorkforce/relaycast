DROP INDEX "idx_messages_channel_time";--> statement-breakpoint
CREATE INDEX "idx_messages_channel_length_id" ON "messages" USING btree ("channel_id",length("id"),"id" COLLATE "C");