ALTER TABLE IF EXISTS "cli_auth_sessions" RENAME TO "cloud_cli_bootstrap_sessions";
--> statement-breakpoint
ALTER INDEX IF EXISTS "cli_auth_sessions_sandbox_unique" RENAME TO "cloud_cli_bootstrap_sessions_sandbox_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_cli_auth_sessions_user" RENAME TO "idx_cloud_cli_bootstrap_sessions_user";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_cli_auth_sessions_expires_at" RENAME TO "idx_cloud_cli_bootstrap_sessions_expires_at";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workforce_cli_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"state" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"token_hash" text,
	"issued_at" timestamp with time zone NOT NULL DEFAULT now(),
	"exchanged_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workforce_cli_auth_sessions_user" ON "workforce_cli_auth_sessions" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workforce_cli_auth_sessions_state_unique" ON "workforce_cli_auth_sessions" USING btree ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workforce_cli_auth_sessions_expires_at" ON "workforce_cli_auth_sessions" USING btree ("expires_at");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "personas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"visibility" text NOT NULL DEFAULT 'private',
	"slug" text NOT NULL,
	"intent" text,
	"tags" text[] NOT NULL DEFAULT '{}'::text[],
	"description" text,
	"harness_kind" text,
	"model" text,
	"use_subscription" boolean NOT NULL DEFAULT false,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "personas_visibility_check" CHECK ("visibility" IN ('private', 'organization'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "personas_owner_slug_unique" ON "personas" USING btree ("owner_user_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personas_org_visible" ON "personas" USING btree ("organization_id") WHERE "visibility" = 'organization';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personas_intent" ON "personas" USING btree ("intent");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personas_tags" ON "personas" USING gin ("tags");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "persona_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"persona_id" uuid NOT NULL REFERENCES "personas"("id") ON DELETE CASCADE,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "persona_versions_persona_version_unique" ON "persona_versions" USING btree ("persona_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "persona_versions_persona_spec_hash_unique" ON "persona_versions" USING btree ("persona_id","spec_hash");
--> statement-breakpoint

ALTER TABLE IF EXISTS "workspace_integrations" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
UPDATE "workspace_integrations" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ADD COLUMN IF NOT EXISTS "adapter" text NOT NULL DEFAULT 'nango';
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ADD COLUMN IF NOT EXISTS "name" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ADD COLUMN IF NOT EXISTS "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" ADD CONSTRAINT "workspace_integrations_adapter_check" CHECK ("adapter" IN ('nango', 'composio', 'pipedream'));
--> statement-breakpoint
ALTER TABLE IF EXISTS "workspace_integrations" DROP CONSTRAINT IF EXISTS "workspace_integrations_workspace_id_provider_pk";
--> statement-breakpoint
DROP INDEX IF EXISTS "workspace_integrations_provider_installation_unique";
--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.workspace_integrations') IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM pg_constraint
			WHERE conname = 'workspace_integrations_pkey'
			  AND conrelid = 'public.workspace_integrations'::regclass
		)
	THEN
		ALTER TABLE "workspace_integrations" ADD CONSTRAINT "workspace_integrations_pkey" PRIMARY KEY ("id");
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_integrations_workspace_provider_default_unique"
	ON "workspace_integrations" USING btree ("workspace_id","provider")
	WHERE "name" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_integrations_workspace_provider_name_unique"
	ON "workspace_integrations" USING btree ("workspace_id","provider","name")
	WHERE "name" IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "user_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"adapter" text NOT NULL DEFAULT 'nango',
	"name" text,
	"connection_id" text NOT NULL,
	"provider_config_key" text,
	"installation_id" text,
	"metadata_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "user_integrations_adapter_check" CHECK ("adapter" IN ('nango', 'composio', 'pipedream'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_integrations_user_provider_default_unique"
	ON "user_integrations" USING btree ("user_id","provider")
	WHERE "name" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_integrations_user_provider_name_unique"
	ON "user_integrations" USING btree ("user_id","provider","name")
	WHERE "name" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_integrations_provider_connection_unique" ON "user_integrations" USING btree ("provider","connection_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_scopes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_integration_id" uuid REFERENCES "user_integrations"("id") ON DELETE CASCADE,
	"workspace_integration_id" uuid REFERENCES "workspace_integrations"("id") ON DELETE CASCADE,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"config_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "integration_scopes_one_owner_check" CHECK (("user_integration_id" IS NULL) <> ("workspace_integration_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_scopes_user_unique"
	ON "integration_scopes" USING btree ("user_integration_id","scope_kind","scope_id")
	WHERE "user_integration_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_scopes_workspace_unique"
	ON "integration_scopes" USING btree ("workspace_integration_id","scope_kind","scope_id")
	WHERE "workspace_integration_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_integration_scopes_scope_kind" ON "integration_scopes" USING btree ("scope_kind");
--> statement-breakpoint

DO $$
BEGIN
	IF to_regclass('public.slack_channel_configs') IS NULL THEN
		RETURN;
	END IF;

	EXECUTE $migrate$
		INSERT INTO "integration_scopes" (
			"id",
			"workspace_integration_id",
			"scope_kind",
			"scope_id",
			"config_json",
			"created_at",
			"updated_at"
		)
		SELECT
			gen_random_uuid(),
			wi."id",
			'slack_channel',
			scc."slack_channel_id",
			jsonb_build_object(
				'is_enabled', scc."is_enabled",
				'is_private', scc."is_private",
				'display_name', scc."slack_channel_name",
				'provider', scc."provider",
				'metadata', COALESCE(scc."metadata_json", '{}'::jsonb)
			),
			scc."created_at",
			scc."updated_at"
		FROM "slack_channel_configs" scc
		JOIN "workspace_integrations" wi
			ON wi."workspace_id" = scc."workspace_id"::text
			AND wi."provider" = scc."provider"
			AND wi."name" IS NULL
		ON CONFLICT DO NOTHING
	$migrate$;
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "slack_channel_configs";
--> statement-breakpoint

DO $$
DECLARE
	has_workspace_id boolean;
	has_provider boolean;
	has_connection_id boolean;
	name_expr text;
	display_name_expr text;
	created_by_expr text;
	provider_config_expr text;
	installation_expr text;
	metadata_expr text;
	adapter_expr text;
	created_at_expr text;
	updated_at_expr text;
BEGIN
	IF to_regclass('public.workspace_service_accounts') IS NULL THEN
		RETURN;
	END IF;

	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'workspace_id'
	) INTO has_workspace_id;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'provider'
	) INTO has_provider;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'connection_id'
	) INTO has_connection_id;

	IF NOT (has_workspace_id AND has_provider AND has_connection_id) THEN
		RETURN;
	END IF;

	name_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'name') THEN '"name"'
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'service_account_name') THEN '"service_account_name"'
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'label') THEN '"label"'
		ELSE '''service-account'''
	END;
	display_name_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'display_name') THEN '"display_name"'
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'name') THEN '"name"'
		ELSE name_expr
	END;
	created_by_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'created_by_user_id') THEN '"created_by_user_id"'
		ELSE 'NULL'
	END;
	provider_config_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'provider_config_key') THEN '"provider_config_key"'
		ELSE 'NULL'
	END;
	installation_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'installation_id') THEN '"installation_id"'
		ELSE 'NULL'
	END;
	metadata_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'metadata_json') THEN '"metadata_json"::text'
		ELSE '''{}'''
	END;
	adapter_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'adapter') THEN '"adapter"'
		ELSE '''nango'''
	END;
	created_at_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'created_at') THEN '"created_at"'
		ELSE 'now()'
	END;
	updated_at_expr := CASE
		WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'workspace_service_accounts' AND column_name = 'updated_at') THEN '"updated_at"'
		ELSE 'now()'
	END;

	EXECUTE format(
		'INSERT INTO "workspace_integrations" (
			"id",
			"workspace_id",
			"provider",
			"adapter",
			"name",
			"display_name",
			"created_by_user_id",
			"connection_id",
			"provider_config_key",
			"installation_id",
			"metadata_json",
			"created_at",
			"updated_at"
		)
		SELECT
			gen_random_uuid(),
			"workspace_id"::text,
			"provider",
			COALESCE(%s, ''nango''),
			%s,
			%s,
			%s,
			"connection_id",
			%s,
			%s,
			COALESCE(%s, ''{}''),
			COALESCE(%s, now()),
			COALESCE(%s, now())
		FROM "workspace_service_accounts"
		WHERE %s IS NOT NULL
		ON CONFLICT DO NOTHING',
		adapter_expr,
		name_expr,
		display_name_expr,
		created_by_expr,
		provider_config_expr,
		installation_expr,
		metadata_expr,
		created_at_expr,
		updated_at_expr,
		name_expr
	);
END $$;
--> statement-breakpoint
DROP TABLE IF EXISTS "workspace_service_accounts";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"persona_id" uuid NOT NULL REFERENCES "personas"("id") ON DELETE CASCADE,
	"deployed_name" text NOT NULL,
	"deployed_by_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
	"credential_selections" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"input_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"pinned_version_id" uuid REFERENCES "persona_versions"("id") ON DELETE SET NULL,
	"spec_hash_at_deploy" text NOT NULL,
	"status" text NOT NULL DEFAULT 'active',
	"destroyed_at" timestamp with time zone,
	"destroyed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"spawned_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
	"watch_globs" text[],
	"schedule_ids" text[],
	"last_used_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "agents_status_check" CHECK ("status" IN ('active', 'disabled', 'error', 'destroyed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_workspace_persona_live_unique"
	ON "agents" USING btree ("workspace_id","persona_id")
	WHERE "status" != 'destroyed';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agents_workspace_deployed_name_live_unique"
	ON "agents" USING btree ("workspace_id","deployed_name")
	WHERE "status" != 'destroyed';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_workspace_status" ON "agents" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agents_spawned_by_agent" ON "agents" USING btree ("spawned_by_agent_id");
--> statement-breakpoint

DO $$
BEGIN
	IF to_regclass('public.agent_deployments') IS NULL THEN
		CREATE TABLE "agent_deployments" (
			"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
			"agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
			"trigger_kind" text NOT NULL DEFAULT 'inbox',
			"trigger_payload" jsonb,
			"started_at" timestamp with time zone NOT NULL DEFAULT now(),
			"last_active_at" timestamp with time zone NOT NULL DEFAULT now(),
			"status" text NOT NULL DEFAULT 'running',
			"spec_hash_at_run" text,
			"timed_out_at" timestamp with time zone,
			"compaction_summary" text,
			"parent_deployment_id" uuid REFERENCES "agent_deployments"("id") ON DELETE SET NULL,
			"created_at" timestamp with time zone NOT NULL DEFAULT now(),
			"updated_at" timestamp with time zone NOT NULL DEFAULT now(),
			CONSTRAINT "agent_deployments_trigger_kind_check" CHECK ("trigger_kind" IN ('inbox', 'clock', 'radio')),
			CONSTRAINT "agent_deployments_status_check" CHECK ("status" IN ('running', 'idle', 'timed_out', 'completed', 'failed'))
		);
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "agent_id" uuid REFERENCES "agents"("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "trigger_kind" text NOT NULL DEFAULT 'inbox';
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "trigger_payload" jsonb;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "started_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "last_active_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "timed_out_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "compaction_summary" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "parent_deployment_id" uuid REFERENCES "agent_deployments"("id") ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments" ADD COLUMN IF NOT EXISTS "spec_hash_at_run" text;
--> statement-breakpoint
DO $$
DECLARE
	has_workspace_id boolean;
	has_persona_id boolean;
	has_deployed_name boolean;
	has_deployed_by_user_id boolean;
	has_pinned_version_id boolean;
	has_spawned_by_agent_id boolean;
BEGIN
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'workspace_id'
	) INTO has_workspace_id;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'persona_id'
	) INTO has_persona_id;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'deployed_name'
	) INTO has_deployed_name;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'deployed_by_user_id'
	) INTO has_deployed_by_user_id;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'pinned_version_id'
	) INTO has_pinned_version_id;
	SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'spawned_by_agent_id'
	) INTO has_spawned_by_agent_id;

	IF has_workspace_id AND has_persona_id AND has_deployed_name AND has_deployed_by_user_id THEN
		EXECUTE format($backfill$
			INSERT INTO "agents" (
				"id",
				"workspace_id",
				"persona_id",
				"deployed_name",
				"deployed_by_user_id",
				"credential_selections",
				"input_values",
				"pinned_version_id",
				"spec_hash_at_deploy",
				"status",
				"destroyed_at",
				"destroyed_by_user_id",
				"spawned_by_agent_id",
				"last_used_at",
				"last_error",
				"created_at",
				"updated_at"
			)
			SELECT
				d."id",
				d."workspace_id",
				d."persona_id",
				d."deployed_name",
				COALESCE(d."deployed_by_user_id", p."owner_user_id"),
				COALESCE(d."credential_selections", '{}'::jsonb),
				COALESCE(d."input_values", '{}'::jsonb),
				%s,
				COALESCE(d."spec_hash_at_deploy", d."spec_hash_at_run", ''),
				CASE d."status"
					WHEN 'disabled' THEN 'disabled'
					WHEN 'error' THEN 'error'
					WHEN 'destroyed' THEN 'destroyed'
					ELSE 'active'
				END,
				d."destroyed_at",
				d."destroyed_by_user_id",
				%s,
				d."last_used_at",
				d."last_error",
				COALESCE(d."created_at", now()),
				COALESCE(d."updated_at", now())
			FROM "agent_deployments" d
			JOIN "personas" p ON p."id" = d."persona_id"
			WHERE d."agent_id" IS NULL
			ON CONFLICT DO NOTHING
		$backfill$,
			CASE WHEN has_pinned_version_id THEN 'd."pinned_version_id"' ELSE 'NULL::uuid' END,
			CASE WHEN has_spawned_by_agent_id THEN 'd."spawned_by_agent_id"' ELSE 'NULL::uuid' END
		);

		EXECUTE $link$
			UPDATE "agent_deployments" d
			SET "agent_id" = a."id"
			FROM "agents" a
			WHERE d."agent_id" IS NULL
				AND a."workspace_id" = d."workspace_id"
				AND a."persona_id" = d."persona_id"
				AND a."deployed_name" = d."deployed_name"
		$link$;
	END IF;

	IF EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'agent_deployments' AND column_name = 'status'
	) THEN
		ALTER TABLE "agent_deployments" DROP CONSTRAINT IF EXISTS "agent_deployments_status_check";
		UPDATE "agent_deployments"
		SET "status" = CASE "status"
			WHEN 'active' THEN 'running'
			WHEN 'disabled' THEN 'completed'
			WHEN 'error' THEN 'failed'
			WHEN 'destroyed' THEN 'completed'
			ELSE "status"
		END;
		ALTER TABLE "agent_deployments"
			ADD CONSTRAINT "agent_deployments_status_check"
			CHECK ("status" IN ('running', 'idle', 'timed_out', 'completed', 'failed'));
	END IF;
END $$;
--> statement-breakpoint
ALTER TABLE IF EXISTS "agent_deployments"
	DROP COLUMN IF EXISTS "workspace_id",
	DROP COLUMN IF EXISTS "persona_id",
	DROP COLUMN IF EXISTS "deployed_name",
	DROP COLUMN IF EXISTS "deployed_by_user_id",
	DROP COLUMN IF EXISTS "credential_selections",
	DROP COLUMN IF EXISTS "input_values",
	DROP COLUMN IF EXISTS "pinned_version_id",
	DROP COLUMN IF EXISTS "spec_hash_at_deploy",
	DROP COLUMN IF EXISTS "destroyed_at",
	DROP COLUMN IF EXISTS "destroyed_by_user_id",
	DROP COLUMN IF EXISTS "spawned_by_agent_id",
	DROP COLUMN IF EXISTS "last_used_at",
	DROP COLUMN IF EXISTS "last_error";
--> statement-breakpoint
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM "agent_deployments" WHERE "agent_id" IS NULL) THEN
		ALTER TABLE "agent_deployments" ALTER COLUMN "agent_id" SET NOT NULL;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_deployments_agent_status" ON "agent_deployments" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_deployments_parent" ON "agent_deployments" USING btree ("parent_deployment_id");
