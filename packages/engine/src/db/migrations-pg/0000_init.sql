CREATE TABLE "relaycast"."a2a_agents" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."a2a_agents_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"relay_agent_id" text NOT NULL,
	"agent_card" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_url" text NOT NULL,
	"auth_scheme" text,
	"auth_credential" text,
	"status" text DEFAULT 'active' NOT NULL,
	"messages_sent" bigint DEFAULT 0 NOT NULL,
	"messages_recv" bigint DEFAULT 0 NOT NULL,
	"last_health" bigint,
	"health_failures" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."a2a_egress" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."a2a_egress_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"target_id" text NOT NULL,
	"external_url" text NOT NULL,
	"fingerprint" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"lease_until" bigint,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"error_status" integer,
	"error_code" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."a2a_egress_context" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."a2a_egress_context_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"response" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."a2a_inbound" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."a2a_inbound_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text,
	"fingerprint" text NOT NULL,
	"response" json,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."action_invocations" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."action_invocations_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"action_id" text,
	"action_name" text NOT NULL,
	"invocation_origin" text DEFAULT 'legacy_unknown' NOT NULL,
	"caller_id" text,
	"caller_name" text,
	"handler_agent_id" text,
	"handler_node_id" text,
	"input" jsonb DEFAULT '{}'::jsonb,
	"task_state" jsonb,
	"output" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"duration_ms" bigint,
	"dispatched_node_id" text,
	"dispatched_at" bigint,
	"node_liveness_revision" bigint DEFAULT 0 NOT NULL,
	"provider_accepted_attempt" integer,
	"spawn_reserved_at" bigint,
	"attempted_node_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_provider" text,
	"retry_after_at" bigint,
	"handler_unreachable_since" bigint,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"completed_at" bigint,
	CONSTRAINT "action_invocations_invocation_origin_check" CHECK ("relaycast"."action_invocations"."invocation_origin" IN ('legacy_unknown', 'registered_action', 'builtin'))
);
--> statement-breakpoint
CREATE TABLE "relaycast"."actions" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."actions_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"handler_agent_id" text,
	"handler_node_id" text,
	"handler_provider" text,
	"is_global" boolean DEFAULT false NOT NULL,
	"queue" boolean DEFAULT false NOT NULL,
	"execution_mode" text DEFAULT 'short' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb,
	"output_schema" jsonb DEFAULT '{}'::jsonb,
	"available_to" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."agent_identity_audit" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."agent_identity_audit_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"action" text NOT NULL,
	"authority" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"session_ref" text,
	"node_id" text,
	"origin_actor" text NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."agent_node_bindings" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."agent_node_bindings_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"node_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"session_ref" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."agent_recovery_credentials" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."agent_recovery_credentials_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"proof_kind" text NOT NULL,
	"verifier_hash" text NOT NULL,
	"work_unit_id" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."agents" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."agents_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'agent' NOT NULL,
	"token_hash" text NOT NULL,
	"previous_token_hash" text,
	"previous_token_expires_at" bigint,
	"status" text DEFAULT 'online' NOT NULL,
	"handle" text,
	"persona" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"capabilities" jsonb,
	"location_type" text DEFAULT 'self_connected' NOT NULL,
	"location_node_id" text,
	"provider_name" text DEFAULT 'default' NOT NULL,
	"resumable" boolean DEFAULT false NOT NULL,
	"session_ref" text,
	"origin_node_id" text,
	"delivery_ack_seq" bigint DEFAULT 0 NOT NULL,
	"delivery_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"last_seen" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"status_updated_at" bigint,
	"status_before_liveness_loss" text,
	"node_liveness_revision" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agents_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."certifications" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."certifications_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_url" text NOT NULL,
	"level" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"passed" boolean DEFAULT false NOT NULL,
	"passed_tests" integer DEFAULT 0 NOT NULL,
	"total_tests" integer DEFAULT 0 NOT NULL,
	"monitor_enabled" boolean DEFAULT false NOT NULL,
	"monitor_interval_minutes" integer DEFAULT 60 NOT NULL,
	"last_run_at" bigint,
	"results" jsonb DEFAULT '[]'::jsonb,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."channel_members" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."channel_members_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"last_read_id" text,
	"is_muted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "channel_members_channel_id_agent_id_pk" PRIMARY KEY("channel_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."channels" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."channels_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_type" integer DEFAULT 0 NOT NULL,
	"topic" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_by" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."credential_upgrades" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."credential_upgrades_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"legacy_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"ar_hash" text NOT NULL,
	"sealed_credential" text NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."deliveries" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."deliveries_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"mode" text DEFAULT 'immediate' NOT NULL,
	"reason" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"deadline" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"location_type" text DEFAULT 'self_connected' NOT NULL,
	"location_node_id" text,
	"route_node_id" text,
	"route_node_kind" text,
	"route_node_role" text,
	"delivery_adapter" text,
	"dispatch_attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint,
	"last_dispatch_error" text,
	"expires_at" bigint,
	"delivered_at" bigint,
	"acked_at" bigint,
	"dead_lettered_at" bigint,
	"retryable" boolean,
	"available_at" bigint,
	"error" text,
	"idempotency_key" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."direct_dm_idempotency" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."direct_dm_idempotency_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."directory_agents" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."directory_agents_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_agent_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"provider" text,
	"endpoint_url" text,
	"documentation_url" text,
	"version" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"rating_sum" bigint DEFAULT 0 NOT NULL,
	"rating_count" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."directory_ratings" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."directory_ratings_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"directory_agent_id" text NOT NULL,
	"rater_agent_id" text NOT NULL,
	"score" integer NOT NULL,
	"review" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."directory_skills" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."directory_skills_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"directory_agent_id" text NOT NULL,
	"skill_id" text,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."dm_conversation_reservations" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."dm_conversation_reservations_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"participant_one_id" text NOT NULL,
	"participant_two_id" text NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	CONSTRAINT "dm_conversation_reservations_sorted_pair_check" CHECK ("relaycast"."dm_conversation_reservations"."participant_one_id" <= "relaycast"."dm_conversation_reservations"."participant_two_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."dm_conversations" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."dm_conversations_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"dm_type" text DEFAULT '1:1' NOT NULL,
	"name" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."dm_participants" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."dm_participants_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"joined_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"left_at" bigint,
	"last_read_id" text,
	CONSTRAINT "dm_participants_conversation_id_agent_id_pk" PRIMARY KEY("conversation_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."event_subscriptions" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."event_subscriptions_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"events" jsonb NOT NULL,
	"filter" jsonb,
	"url" text NOT NULL,
	"headers" jsonb,
	"secret" text,
	"signature_scheme" text DEFAULT 'legacy' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."file_cleanup_queue" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."file_cleanup_queue_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"storage_key" text PRIMARY KEY NOT NULL,
	"delete_after" bigint NOT NULL,
	"process_after" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."files" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."files_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"upload_expires_at" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."maintenance_cursors" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."maintenance_cursors_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"cursor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."message_attachments" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."message_attachments_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"file_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "message_attachments_message_id_file_id_pk" PRIMARY KEY("message_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."message_logs" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."message_logs_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"message_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"conversation_id" text,
	"delivery_kind" text NOT NULL,
	"body" text NOT NULL,
	"content_type" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"latency_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."message_sessions" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."message_sessions_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text NOT NULL,
	"session_ref" text NOT NULL,
	"first_message_at" bigint NOT NULL,
	"last_message_at" bigint NOT NULL,
	"start_is_known" boolean DEFAULT true NOT NULL,
	CONSTRAINT "message_sessions_workspace_id_session_ref_pk" PRIMARY KEY("workspace_id","session_ref")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."messages" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."messages_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text,
	"body" text NOT NULL,
	"blocks" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"session_ref" text,
	"has_attachments" boolean DEFAULT false NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."node_providers" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."node_providers_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"node_id" text NOT NULL,
	"name" text NOT NULL,
	"instance_id" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_agents" integer DEFAULT 0 NOT NULL,
	"active_agents" integer DEFAULT 0 NOT NULL,
	"load" double precision DEFAULT 0 NOT NULL,
	"load_reported" boolean DEFAULT false NOT NULL,
	"handlers_live" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"version" text DEFAULT 'unknown' NOT NULL,
	"last_heartbeat_at" bigint,
	"liveness_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."nodes" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."nodes_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"previous_token_hash" text,
	"previous_token_expires_at" bigint,
	"rotation_idempotency_key_hash" text,
	"rotation_request_digest" text,
	"machine_id" text,
	"kind" text DEFAULT 'fleet_ws' NOT NULL,
	"role" text DEFAULT 'broker' NOT NULL,
	"delivery_adapter" text DEFAULT 'fleet.ws.v1' NOT NULL,
	"delivery_config" jsonb,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_agents" integer DEFAULT 0 NOT NULL,
	"active_agents" integer DEFAULT 0 NOT NULL,
	"reserved_agents" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" text DEFAULT 'unknown' NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"handlers_live" boolean DEFAULT false NOT NULL,
	"load" double precision DEFAULT 0 NOT NULL,
	"load_reported" boolean DEFAULT false NOT NULL,
	"last_heartbeat_at" bigint,
	"proven_live_at" bigint,
	"liveness_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	CONSTRAINT "nodes_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "nodes_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."observer_tokens" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."observer_tokens_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expires_at" bigint,
	"created_by" text,
	"created_by_type" text DEFAULT 'workspace' NOT NULL,
	"last_used_at" bigint,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."pending_events" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."pending_events_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"webhook_initialized" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"process_after" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."reactions" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."reactions_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"emoji" text NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."read_receipts" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."read_receipts_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"read_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	CONSTRAINT "read_receipts_message_id_agent_id_pk" PRIMARY KEY("message_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."routing_configs" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."routing_configs_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text PRIMARY KEY NOT NULL,
	"weights" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"circuit_breaker_threshold" integer DEFAULT 3 NOT NULL,
	"circuit_breaker_cooldown_seconds" integer DEFAULT 300 NOT NULL,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."routing_failures" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."routing_failures_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"total_failures" bigint DEFAULT 0 NOT NULL,
	"total_successes" bigint DEFAULT 0 NOT NULL,
	"last_failure_at" bigint,
	"last_success_at" bigint,
	"circuit_open_until" bigint,
	"last_error" text,
	"updated_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	CONSTRAINT "routing_failures_workspace_id_agent_id_pk" PRIMARY KEY("workspace_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."session_events" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."session_events_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key_hash" text,
	"request_digest" text,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"status_applied_at" bigint,
	"status_legacy_pending" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."triggers" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."triggers_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"channel" text,
	"pattern" text,
	"mention" boolean,
	"action_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_triggered_at" bigint,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."usage_records" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."usage_records_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"period_start" bigint NOT NULL,
	"period_end" bigint NOT NULL,
	"messages_sent" bigint DEFAULT 0 NOT NULL,
	"api_calls" bigint DEFAULT 0 NOT NULL,
	"files_uploaded" bigint DEFAULT 0 NOT NULL,
	"file_bytes" bigint DEFAULT 0 NOT NULL,
	"ws_minutes" bigint DEFAULT 0 NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."webhook_deliveries" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."webhook_deliveries_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"subscription_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"last_error" text,
	"last_status" integer,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"completed_at" bigint
);
--> statement-breakpoint
CREATE TABLE "relaycast"."webhooks" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."webhooks_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"channel_id" text NOT NULL,
	"created_by" text,
	"token_hash" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relaycast"."workspace_create_idempotency" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."workspace_create_idempotency_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"owner_scope_hash" text NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_digest" text NOT NULL,
	"workspace_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"terminalized_at" bigint,
	CONSTRAINT "workspace_create_idempotency_owner_scope_hash_idempotency_key_hash_pk" PRIMARY KEY("owner_scope_hash","idempotency_key_hash")
);
--> statement-breakpoint
CREATE TABLE "relaycast"."workspace_events" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."workspace_events_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"channel_id" text,
	"payload" text NOT NULL,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	CONSTRAINT "workspace_events_workspace_id_seq_pk" PRIMARY KEY("workspace_id","seq"),
	CONSTRAINT "workspace_events_seq_positive_check" CHECK ("relaycast"."workspace_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "relaycast"."workspaces" (
	"rowid" bigint GENERATED ALWAYS AS IDENTITY (sequence name "relaycast"."workspaces_rowid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"previous_api_key_hash" text,
	"previous_api_key_expires_at" bigint,
	"api_key_generation" bigint DEFAULT 0 NOT NULL,
	"system_prompt" text,
	"created_at" bigint DEFAULT floor(extract(epoch from statement_timestamp()))::bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"retention" jsonb,
	"expires_at" bigint,
	"provenance" jsonb,
	"usage_classification" text DEFAULT 'unknown' NOT NULL,
	"classification_source" text DEFAULT 'unclassified' NOT NULL,
	"classification_reason" text,
	"classified_at" bigint,
	CONSTRAINT "workspaces_api_key_hash_unique" UNIQUE("api_key_hash"),
	CONSTRAINT "workspaces_usage_classification_source_check" CHECK ((
        ("relaycast"."workspaces"."usage_classification" = 'unknown' AND "relaycast"."workspaces"."classification_source" = 'unclassified')
        OR (
          "relaycast"."workspaces"."usage_classification" IN ('internal', 'external')
          AND "relaycast"."workspaces"."classification_source" IN ('creator', 'operator')
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_agents" ADD CONSTRAINT "a2a_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_agents" ADD CONSTRAINT "a2a_agents_relay_agent_id_agents_id_fk" FOREIGN KEY ("relay_agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_egress" ADD CONSTRAINT "a2a_egress_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_egress_context" ADD CONSTRAINT "a2a_egress_context_id_a2a_egress_id_fk" FOREIGN KEY ("id") REFERENCES "relaycast"."a2a_egress"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_egress_context" ADD CONSTRAINT "a2a_egress_context_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_inbound" ADD CONSTRAINT "a2a_inbound_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."a2a_inbound" ADD CONSTRAINT "a2a_inbound_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."action_invocations" ADD CONSTRAINT "action_invocations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."action_invocations" ADD CONSTRAINT "action_invocations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "relaycast"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."action_invocations" ADD CONSTRAINT "action_invocations_caller_id_agents_id_fk" FOREIGN KEY ("caller_id") REFERENCES "relaycast"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."action_invocations" ADD CONSTRAINT "action_invocations_dispatched_node_id_nodes_id_fk" FOREIGN KEY ("dispatched_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."actions" ADD CONSTRAINT "actions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."actions" ADD CONSTRAINT "actions_handler_agent_id_agents_id_fk" FOREIGN KEY ("handler_agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."actions" ADD CONSTRAINT "actions_handler_node_id_nodes_id_fk" FOREIGN KEY ("handler_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_identity_audit" ADD CONSTRAINT "agent_identity_audit_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_node_bindings" ADD CONSTRAINT "agent_node_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_node_bindings" ADD CONSTRAINT "agent_node_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_node_bindings" ADD CONSTRAINT "agent_node_bindings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_node_bindings" ADD CONSTRAINT "agent_node_bindings_agent_workspace_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "relaycast"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_node_bindings" ADD CONSTRAINT "agent_node_bindings_node_workspace_fk" FOREIGN KEY ("workspace_id","node_id") REFERENCES "relaycast"."nodes"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_recovery_credentials" ADD CONSTRAINT "agent_recovery_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agent_recovery_credentials" ADD CONSTRAINT "agent_recovery_credentials_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "relaycast"."agents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agents" ADD CONSTRAINT "agents_location_node_id_nodes_id_fk" FOREIGN KEY ("location_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."agents" ADD CONSTRAINT "agents_origin_node_id_nodes_id_fk" FOREIGN KEY ("origin_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."certifications" ADD CONSTRAINT "certifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "relaycast"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."channel_members" ADD CONSTRAINT "channel_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."channels" ADD CONSTRAINT "channels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."channels" ADD CONSTRAINT "channels_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "relaycast"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."credential_upgrades" ADD CONSTRAINT "credential_upgrades_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."deliveries" ADD CONSTRAINT "deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."deliveries" ADD CONSTRAINT "deliveries_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."deliveries" ADD CONSTRAINT "deliveries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."deliveries" ADD CONSTRAINT "deliveries_location_node_id_nodes_id_fk" FOREIGN KEY ("location_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."deliveries" ADD CONSTRAINT "deliveries_route_node_id_nodes_id_fk" FOREIGN KEY ("route_node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."direct_dm_idempotency" ADD CONSTRAINT "direct_dm_idempotency_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_agents" ADD CONSTRAINT "directory_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_agents" ADD CONSTRAINT "directory_agents_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_ratings" ADD CONSTRAINT "directory_ratings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_ratings" ADD CONSTRAINT "directory_ratings_directory_agent_id_directory_agents_id_fk" FOREIGN KEY ("directory_agent_id") REFERENCES "relaycast"."directory_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_ratings" ADD CONSTRAINT "directory_ratings_rater_agent_id_agents_id_fk" FOREIGN KEY ("rater_agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_skills" ADD CONSTRAINT "directory_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."directory_skills" ADD CONSTRAINT "directory_skills_directory_agent_id_directory_agents_id_fk" FOREIGN KEY ("directory_agent_id") REFERENCES "relaycast"."directory_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."dm_conversation_reservations" ADD CONSTRAINT "dm_conversation_reservations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."dm_conversations" ADD CONSTRAINT "dm_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."dm_conversations" ADD CONSTRAINT "dm_conversations_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "relaycast"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."dm_participants" ADD CONSTRAINT "dm_participants_conversation_id_dm_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "relaycast"."dm_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."dm_participants" ADD CONSTRAINT "dm_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."event_subscriptions" ADD CONSTRAINT "event_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."files" ADD CONSTRAINT "files_uploaded_by_agents_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "relaycast"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_attachments" ADD CONSTRAINT "message_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "relaycast"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_logs" ADD CONSTRAINT "message_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_logs" ADD CONSTRAINT "message_logs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_logs" ADD CONSTRAINT "message_logs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "relaycast"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_logs" ADD CONSTRAINT "message_logs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."message_sessions" ADD CONSTRAINT "message_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "relaycast"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."messages" ADD CONSTRAINT "messages_thread_id_messages_id_fk" FOREIGN KEY ("thread_id") REFERENCES "relaycast"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."node_providers" ADD CONSTRAINT "node_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."node_providers" ADD CONSTRAINT "node_providers_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "relaycast"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."nodes" ADD CONSTRAINT "nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."observer_tokens" ADD CONSTRAINT "observer_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."pending_events" ADD CONSTRAINT "pending_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."reactions" ADD CONSTRAINT "reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."reactions" ADD CONSTRAINT "reactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."read_receipts" ADD CONSTRAINT "read_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "relaycast"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."read_receipts" ADD CONSTRAINT "read_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."routing_configs" ADD CONSTRAINT "routing_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."routing_failures" ADD CONSTRAINT "routing_failures_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."routing_failures" ADD CONSTRAINT "routing_failures_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."session_events" ADD CONSTRAINT "session_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."session_events" ADD CONSTRAINT "session_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "relaycast"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."usage_records" ADD CONSTRAINT "usage_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_pending_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "relaycast"."pending_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_subscription_id_event_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "relaycast"."event_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "relaycast"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."webhooks" ADD CONSTRAINT "webhooks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "relaycast"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relaycast"."webhooks" ADD CONSTRAINT "webhooks_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "relaycast"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_agents_rowid_unique" ON "relaycast"."a2a_agents" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_a2a_agents_workspace" ON "relaycast"."a2a_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_a2a_agents_relay_agent" ON "relaycast"."a2a_agents" USING btree ("relay_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_egress_rowid_unique" ON "relaycast"."a2a_egress" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_a2a_egress_workspace" ON "relaycast"."a2a_egress" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_egress_due" ON "relaycast"."a2a_egress" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "idx_a2a_egress_retention" ON "relaycast"."a2a_egress" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_egress_context_rowid_unique" ON "relaycast"."a2a_egress_context" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_a2a_egress_context_message" ON "relaycast"."a2a_egress_context" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "a2a_inbound_rowid_unique" ON "relaycast"."a2a_inbound" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_a2a_inbound_workspace" ON "relaycast"."a2a_inbound" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_inbound_message" ON "relaycast"."a2a_inbound" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_a2a_inbound_retention" ON "relaycast"."a2a_inbound" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "action_invocations_rowid_unique" ON "relaycast"."action_invocations" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_workspace" ON "relaycast"."action_invocations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_action" ON "relaycast"."action_invocations" USING btree ("action_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_caller" ON "relaycast"."action_invocations" USING btree ("caller_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_dispatched_node" ON "relaycast"."action_invocations" USING btree ("dispatched_node_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_dispatched_node_liveness_revision" ON "relaycast"."action_invocations" USING btree ("workspace_id","dispatched_node_id","node_liveness_revision") WHERE "relaycast"."action_invocations"."dispatched_node_id" IS NOT NULL AND "relaycast"."action_invocations"."status" IN ('pending', 'dispatched', 'invoked');--> statement-breakpoint
CREATE INDEX "idx_action_invocations_pending_workspace" ON "relaycast"."action_invocations" USING btree ("workspace_id","created_at") WHERE "relaycast"."action_invocations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_action_invocations_spawn_canceled" ON "relaycast"."action_invocations" USING btree ("workspace_id","dispatched_node_id");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_status_dispatched" ON "relaycast"."action_invocations" USING btree ("status","dispatched_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_status_retry_after" ON "relaycast"."action_invocations" USING btree ("status","retry_after_at");--> statement-breakpoint
CREATE INDEX "idx_action_invocations_status_task_deadline" ON "relaycast"."action_invocations" USING btree ("status",(("task_state" ->> 'deadline') COLLATE "C")) WHERE "relaycast"."action_invocations"."task_state" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_action_invocations_task_deadline" ON "relaycast"."action_invocations" USING btree ((("task_state" ->> 'deadline') COLLATE "C")) WHERE "relaycast"."action_invocations"."task_state" IS NOT NULL AND "relaycast"."action_invocations"."status" IN ('pending', 'dispatched', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "actions_rowid_unique" ON "relaycast"."actions" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_workspace_node_name_unique" ON "relaycast"."actions" USING btree ("workspace_id","handler_node_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "actions_workspace_agent_name_unique" ON "relaycast"."actions" USING btree ("workspace_id","name") WHERE "relaycast"."actions"."handler_node_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "actions_workspace_global_name_unique" ON "relaycast"."actions" USING btree ("workspace_id","name") WHERE "relaycast"."actions"."is_global" = true;--> statement-breakpoint
CREATE INDEX "idx_actions_workspace" ON "relaycast"."actions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_actions_handler" ON "relaycast"."actions" USING btree ("handler_agent_id");--> statement-breakpoint
CREATE INDEX "idx_actions_node_handler" ON "relaycast"."actions" USING btree ("handler_node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_identity_audit_rowid_unique" ON "relaycast"."agent_identity_audit" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_agent_identity_audit_workspace" ON "relaycast"."agent_identity_audit" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_identity_audit_agent" ON "relaycast"."agent_identity_audit" USING btree ("workspace_id","agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_node_bindings_rowid_unique" ON "relaycast"."agent_node_bindings" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_node_bindings_agent_node_unique" ON "relaycast"."agent_node_bindings" USING btree ("agent_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_agent_node_bindings_workspace" ON "relaycast"."agent_node_bindings" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_node_bindings_agent" ON "relaycast"."agent_node_bindings" USING btree ("workspace_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_node_bindings_node" ON "relaycast"."agent_node_bindings" USING btree ("workspace_id","node_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_node_bindings_node_fk" ON "relaycast"."agent_node_bindings" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recovery_credentials_rowid_unique" ON "relaycast"."agent_recovery_credentials" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recovery_credentials_agent_unique" ON "relaycast"."agent_recovery_credentials" USING btree ("workspace_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_recovery_credentials_verifier_unique" ON "relaycast"."agent_recovery_credentials" USING btree ("verifier_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_rowid_unique" ON "relaycast"."agents" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_name_unique" ON "relaycast"."agents" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "idx_agents_workspace" ON "relaycast"."agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agents_roster" ON "relaycast"."agents" USING btree ("workspace_id","status","last_seen") WHERE "relaycast"."agents"."status" <> 'released';--> statement-breakpoint
CREATE INDEX "idx_agents_location_node_fk" ON "relaycast"."agents" USING btree ("location_node_id") WHERE "relaycast"."agents"."location_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agents_location_node_liveness_revision" ON "relaycast"."agents" USING btree ("workspace_id","location_node_id","node_liveness_revision") WHERE "relaycast"."agents"."location_type" = 'via_node' AND "relaycast"."agents"."location_node_id" IS NOT NULL AND "relaycast"."agents"."status" NOT IN ('offline', 'released');--> statement-breakpoint
CREATE INDEX "idx_agents_origin_node_fk" ON "relaycast"."agents" USING btree ("origin_node_id") WHERE "relaycast"."agents"."origin_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_agents_token" ON "relaycast"."agents" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_agents_previous_token" ON "relaycast"."agents" USING btree ("previous_token_hash");--> statement-breakpoint
CREATE INDEX "idx_agents_active_last_seen" ON "relaycast"."agents" USING btree ("last_seen") WHERE "relaycast"."agents"."status" IN ('active', 'online');--> statement-breakpoint
CREATE UNIQUE INDEX "certifications_rowid_unique" ON "relaycast"."certifications" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_certifications_workspace" ON "relaycast"."certifications" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_certifications_agent_url" ON "relaycast"."certifications" USING btree ("agent_url");--> statement-breakpoint
CREATE INDEX "idx_certifications_monitor_enabled" ON "relaycast"."certifications" USING btree ("monitor_enabled","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_rowid_unique" ON "relaycast"."channel_members" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_channel_members_agent" ON "relaycast"."channel_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_rowid_unique" ON "relaycast"."channels" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_workspace_name_unique" ON "relaycast"."channels" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "idx_channels_workspace" ON "relaycast"."channels" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_channels_creator" ON "relaycast"."channels" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_upgrades_rowid_unique" ON "relaycast"."credential_upgrades" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_credential_upgrades_workspace" ON "relaycast"."credential_upgrades" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_rowid_unique" ON "relaycast"."deliveries" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_message_agent_unique" ON "relaycast"."deliveries" USING btree ("message_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_deliveries_location_node_fk" ON "relaycast"."deliveries" USING btree ("location_node_id") WHERE "relaycast"."deliveries"."location_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_route_node_fk" ON "relaycast"."deliveries" USING btree ("route_node_id") WHERE "relaycast"."deliveries"."route_node_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_active_location_node" ON "relaycast"."deliveries" USING btree ("location_node_id") WHERE "relaycast"."deliveries"."status" IN ('queued', 'delivered') AND "relaycast"."deliveries"."location_node_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deliveries_id_lookup" ON "relaycast"."deliveries" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_agent_seq_unique" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","seq");--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent" ON "relaycast"."deliveries" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent_status_seq" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","status","seq");--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent_active_seq" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","seq") WHERE "relaycast"."deliveries"."status" IN ('queued', 'delivered');--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent_active_expiry" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","expires_at") WHERE "relaycast"."deliveries"."status" IN ('queued', 'delivered');--> statement-breakpoint
CREATE INDEX "idx_deliveries_settled_retention" ON "relaycast"."deliveries" USING btree ("created_at","id") WHERE "relaycast"."deliveries"."status" IN ('acked', 'failed', 'dead_lettered');--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent_active_created" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","created_at","id") WHERE "relaycast"."deliveries"."status" IN ('queued', 'delivered');--> statement-breakpoint
CREATE INDEX "idx_deliveries_expires" ON "relaycast"."deliveries" USING btree ("workspace_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_deliveries_active_expiry" ON "relaycast"."deliveries" USING btree ("expires_at","id") WHERE "relaycast"."deliveries"."status" IN ('queued', 'delivered') AND "relaycast"."deliveries"."expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_retry_due" ON "relaycast"."deliveries" USING btree ("status","next_attempt_at","created_at","id") WHERE "relaycast"."deliveries"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_node_initial" ON "relaycast"."deliveries" USING btree ("created_at","id") WHERE "relaycast"."deliveries"."status" = 'queued' AND "relaycast"."deliveries"."route_node_kind" IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND "relaycast"."deliveries"."next_attempt_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_node_initial_workspace" ON "relaycast"."deliveries" USING btree ("workspace_id","created_at","id") WHERE "relaycast"."deliveries"."status" = 'queued' AND "relaycast"."deliveries"."route_node_kind" IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND "relaycast"."deliveries"."next_attempt_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_node_retry" ON "relaycast"."deliveries" USING btree ("next_attempt_at","created_at","id") WHERE "relaycast"."deliveries"."status" = 'queued' AND "relaycast"."deliveries"."route_node_kind" IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND "relaycast"."deliveries"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_node_retry_workspace" ON "relaycast"."deliveries" USING btree ("workspace_id","next_attempt_at","created_at","id") WHERE "relaycast"."deliveries"."status" = 'queued' AND "relaycast"."deliveries"."route_node_kind" IN ('http_push', 'ws', 'fleet_ws', 'direct_ws') AND "relaycast"."deliveries"."next_attempt_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_deliveries_status" ON "relaycast"."deliveries" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_deliveries_agent_status_created" ON "relaycast"."deliveries" USING btree ("workspace_id","agent_id","status","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "direct_dm_idempotency_rowid_unique" ON "relaycast"."direct_dm_idempotency" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_direct_dm_idempotency_workspace_created" ON "relaycast"."direct_dm_idempotency" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_direct_dm_idempotency_retention" ON "relaycast"."direct_dm_idempotency" USING btree ("created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_agents_rowid_unique" ON "relaycast"."directory_agents" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_agents_workspace_slug_unique" ON "relaycast"."directory_agents" USING btree ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX "idx_directory_agents_workspace" ON "relaycast"."directory_agents" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_directory_agents_source_agent" ON "relaycast"."directory_agents" USING btree ("source_agent_id");--> statement-breakpoint
CREATE INDEX "idx_directory_agents_status" ON "relaycast"."directory_agents" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_ratings_rowid_unique" ON "relaycast"."directory_ratings" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_ratings_agent_rater_unique" ON "relaycast"."directory_ratings" USING btree ("directory_agent_id","rater_agent_id");--> statement-breakpoint
CREATE INDEX "idx_directory_ratings_workspace" ON "relaycast"."directory_ratings" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_directory_ratings_rater" ON "relaycast"."directory_ratings" USING btree ("rater_agent_id");--> statement-breakpoint
CREATE INDEX "idx_directory_ratings_directory_agent" ON "relaycast"."directory_ratings" USING btree ("directory_agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_skills_rowid_unique" ON "relaycast"."directory_skills" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_directory_skills_agent" ON "relaycast"."directory_skills" USING btree ("directory_agent_id","position");--> statement-breakpoint
CREATE INDEX "idx_directory_skills_workspace" ON "relaycast"."directory_skills" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_conversation_reservations_rowid_unique" ON "relaycast"."dm_conversation_reservations" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_conversation_reservations_pair_unique" ON "relaycast"."dm_conversation_reservations" USING btree ("workspace_id","participant_one_id","participant_two_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_conversations_rowid_unique" ON "relaycast"."dm_conversations" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_dm_conversations_workspace" ON "relaycast"."dm_conversations" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_dm_conversations_channel" ON "relaycast"."dm_conversations" USING btree ("channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dm_participants_rowid_unique" ON "relaycast"."dm_participants" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_dm_participants_agent" ON "relaycast"."dm_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_subscriptions_rowid_unique" ON "relaycast"."event_subscriptions" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_event_subscriptions_workspace" ON "relaycast"."event_subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_cleanup_queue_rowid_unique" ON "relaycast"."file_cleanup_queue" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_file_cleanup_due" ON "relaycast"."file_cleanup_queue" USING btree ("process_after","storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "files_rowid_unique" ON "relaycast"."files" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_files_workspace" ON "relaycast"."files" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_files_uploader" ON "relaycast"."files" USING btree ("uploaded_by");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_cursors_rowid_unique" ON "relaycast"."maintenance_cursors" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachments_rowid_unique" ON "relaycast"."message_attachments" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_message_attachments_file" ON "relaycast"."message_attachments" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_logs_rowid_unique" ON "relaycast"."message_logs" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "message_logs_message_unique" ON "relaycast"."message_logs" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_message_logs_workspace_time" ON "relaycast"."message_logs" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "idx_message_logs_retention" ON "relaycast"."message_logs" USING btree (length("id"),"id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_message_logs_agent_time" ON "relaycast"."message_logs" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "idx_message_logs_channel_time" ON "relaycast"."message_logs" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX "idx_message_logs_conversation_time" ON "relaycast"."message_logs" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_sessions_rowid_unique" ON "relaycast"."message_sessions" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_message_sessions_workspace_last" ON "relaycast"."message_sessions" USING btree ("workspace_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_rowid_unique" ON "relaycast"."messages" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_messages_channel_time" ON "relaycast"."messages" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_retention" ON "relaycast"."messages" USING btree (length("id"),"id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_messages_thread" ON "relaycast"."messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_workspace" ON "relaycast"."messages" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "idx_messages_workspace_length_id" ON "relaycast"."messages" USING btree ("workspace_id",length("id"),"id" COLLATE "C");--> statement-breakpoint
CREATE INDEX "idx_messages_agent" ON "relaycast"."messages" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_messages_workspace_session" ON "relaycast"."messages" USING btree ("workspace_id","session_ref",length("id"),"id" COLLATE "C");--> statement-breakpoint
CREATE UNIQUE INDEX "node_providers_rowid_unique" ON "relaycast"."node_providers" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "node_providers_node_name_unique" ON "relaycast"."node_providers" USING btree ("workspace_id","node_id","name");--> statement-breakpoint
CREATE INDEX "idx_node_providers_node" ON "relaycast"."node_providers" USING btree ("workspace_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_node_providers_liveness_revision" ON "relaycast"."node_providers" USING btree ("workspace_id","node_id","liveness_revision");--> statement-breakpoint
CREATE INDEX "idx_node_providers_node_fk" ON "relaycast"."node_providers" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_rowid_unique" ON "relaycast"."nodes" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_workspace_name_unique" ON "relaycast"."nodes" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "idx_nodes_workspace" ON "relaycast"."nodes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_nodes_token" ON "relaycast"."nodes" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_nodes_status" ON "relaycast"."nodes" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_nodes_status_heartbeat" ON "relaycast"."nodes" USING btree ("workspace_id","status","last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_nodes_workspace_machine" ON "relaycast"."nodes" USING btree ("workspace_id","machine_id");--> statement-breakpoint
CREATE INDEX "idx_nodes_workspace_machine_proven" ON "relaycast"."nodes" USING btree ("workspace_id","machine_id","proven_live_at");--> statement-breakpoint
CREATE INDEX "idx_nodes_workspace_previous_token" ON "relaycast"."nodes" USING btree ("workspace_id","previous_token_hash");--> statement-breakpoint
CREATE INDEX "idx_nodes_online_liveness" ON "relaycast"."nodes" USING btree ("last_heartbeat_at","workspace_id","id") WHERE "relaycast"."nodes"."status" = 'online';--> statement-breakpoint
CREATE INDEX "idx_nodes_context_reachable" ON "relaycast"."nodes" USING btree ("workspace_id","id") WHERE "relaycast"."nodes"."kind" = 'http_push' OR ("relaycast"."nodes"."kind" IN ('ws', 'fleet_ws', 'direct_ws') AND "relaycast"."nodes"."status" <> 'offline');--> statement-breakpoint
CREATE UNIQUE INDEX "observer_tokens_rowid_unique" ON "relaycast"."observer_tokens" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "observer_tokens_workspace_name_unique" ON "relaycast"."observer_tokens" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "observer_tokens_token_hash_unique" ON "relaycast"."observer_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_observer_tokens_workspace_status" ON "relaycast"."observer_tokens" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "idx_observer_tokens_expires_at" ON "relaycast"."observer_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_events_rowid_unique" ON "relaycast"."pending_events" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_pending_events_status" ON "relaycast"."pending_events" USING btree ("status","process_after");--> statement-breakpoint
CREATE INDEX "idx_pending_events_settled_retention" ON "relaycast"."pending_events" USING btree ("status","completed_at","id");--> statement-breakpoint
CREATE INDEX "idx_pending_events_workspace" ON "relaycast"."pending_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_rowid_unique" ON "relaycast"."reactions" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "reactions_message_agent_emoji_unique" ON "relaycast"."reactions" USING btree ("message_id","agent_id","emoji");--> statement-breakpoint
CREATE INDEX "idx_reactions_message" ON "relaycast"."reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_reactions_agent" ON "relaycast"."reactions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "read_receipts_rowid_unique" ON "relaycast"."read_receipts" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_read_receipts_retention" ON "relaycast"."read_receipts" USING btree ("message_id","agent_id");--> statement-breakpoint
CREATE INDEX "idx_read_receipts_agent" ON "relaycast"."read_receipts" USING btree ("agent_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_configs_rowid_unique" ON "relaycast"."routing_configs" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_routing_configs_updated_at" ON "relaycast"."routing_configs" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "routing_failures_rowid_unique" ON "relaycast"."routing_failures" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_routing_failures_workspace" ON "relaycast"."routing_failures" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_routing_failures_agent" ON "relaycast"."routing_failures" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "idx_routing_failures_circuit" ON "relaycast"."routing_failures" USING btree ("workspace_id","circuit_open_until");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_rowid_unique" ON "relaycast"."session_events" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_agent_sequence_unique" ON "relaycast"."session_events" USING btree ("agent_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "session_events_agent_idempotency_unique" ON "relaycast"."session_events" USING btree ("workspace_id","agent_id","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "idx_session_events_agent" ON "relaycast"."session_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_session_events_workspace" ON "relaycast"."session_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_session_events_type" ON "relaycast"."session_events" USING btree ("workspace_id","type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_rowid_unique" ON "relaycast"."triggers" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_triggers_workspace" ON "relaycast"."triggers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_triggers_enabled" ON "relaycast"."triggers" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE INDEX "idx_triggers_action" ON "relaycast"."triggers" USING btree ("workspace_id","action_name");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_records_rowid_unique" ON "relaycast"."usage_records" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_usage_workspace_period" ON "relaycast"."usage_records" USING btree ("workspace_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_rowid_unique" ON "relaycast"."webhook_deliveries" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_subscription_unique" ON "relaycast"."webhook_deliveries" USING btree ("event_id","subscription_id");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_due" ON "relaycast"."webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "idx_webhook_deliveries_subscription" ON "relaycast"."webhook_deliveries" USING btree ("subscription_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_rowid_unique" ON "relaycast"."webhooks" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_workspace_name_unique" ON "relaycast"."webhooks" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "idx_webhooks_workspace" ON "relaycast"."webhooks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_webhooks_creator" ON "relaycast"."webhooks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_webhooks_token" ON "relaycast"."webhooks" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_create_idempotency_rowid_unique" ON "relaycast"."workspace_create_idempotency" USING btree ("rowid");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_create_idempotency_workspace_unique" ON "relaycast"."workspace_create_idempotency" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_events_rowid_unique" ON "relaycast"."workspace_events" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_workspace_events_created" ON "relaycast"."workspace_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workspace_events_retention" ON "relaycast"."workspace_events" USING btree ("created_at","workspace_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_rowid_unique" ON "relaycast"."workspaces" USING btree ("rowid");--> statement-breakpoint
CREATE INDEX "idx_workspaces_expires_at" ON "relaycast"."workspaces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_workspaces_previous_api_key" ON "relaycast"."workspaces" USING btree ("previous_api_key_hash");--> statement-breakpoint
CREATE INDEX "idx_workspaces_usage_classification" ON "relaycast"."workspaces" USING btree ("usage_classification","created_at");