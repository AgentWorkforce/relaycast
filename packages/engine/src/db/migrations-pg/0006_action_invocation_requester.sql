ALTER TABLE "action_invocations" ADD COLUMN "requester_agent_id" text;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD COLUMN "requester_name" text;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_requester_agent_id_agents_id_fk" FOREIGN KEY ("requester_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;