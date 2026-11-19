CREATE TABLE "agent_device_tokens" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "agent_device_tokens_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"device_id" text NOT NULL,
	"device_name" text NOT NULL,
	"device_kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" bigint,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "device_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_device_tokens" ADD CONSTRAINT "agent_device_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_device_tokens" ADD CONSTRAINT "agent_device_tokens_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_tokens_rowid_unique" ON "agent_device_tokens" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_tokens_agent_device_unique" ON "agent_device_tokens" USING btree ("workspace_id","agent_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_device_tokens_token_hash_unique" ON "agent_device_tokens" USING btree ("token_hash");