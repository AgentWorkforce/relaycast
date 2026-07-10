DO $$
BEGIN
  -- Idempotency guard for environments that have not yet renamed the legacy
  -- credential table. The remaining cloud_agents references below are legacy
  -- rename/drop targets, not missed application references.
  IF to_regclass('public.provider_credentials') IS NULL
    AND to_regclass('public.cloud_agents') IS NOT NULL
  THEN
    ALTER TABLE "cloud_agents" RENAME TO "provider_credentials";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.provider_credential_auth_sessions') IS NULL
    AND to_regclass('public.cloud_agent_auth_sessions') IS NOT NULL
  THEN
    ALTER TABLE "cloud_agent_auth_sessions" RENAME TO "provider_credential_auth_sessions";
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.provider_credential_auth_sessions') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'provider_credential_auth_sessions'
        AND column_name = 'cloud_agent_id'
    )
  THEN
    ALTER TABLE "provider_credential_auth_sessions"
      RENAME COLUMN "cloud_agent_id" TO "provider_credential_id";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE IF EXISTS "provider_credentials"
  ADD COLUMN IF NOT EXISTS "model_provider" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE IF EXISTS "provider_credentials"
  ADD COLUMN IF NOT EXISTS "auth_type" text NOT NULL DEFAULT 'provider_oauth';
--> statement-breakpoint
ALTER TABLE IF EXISTS "provider_credentials"
  ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE IF EXISTS "provider_credentials"
  ADD COLUMN IF NOT EXISTS "key_fingerprint" text;
--> statement-breakpoint
UPDATE "provider_credentials"
SET "model_provider" = CASE
  WHEN "harness" = 'claude' THEN 'anthropic'
  WHEN "harness" = 'anthropic' THEN 'anthropic'
  WHEN "harness" = 'codex' THEN 'openai'
  WHEN "harness" = 'openai' THEN 'openai'
  WHEN "harness" = 'opencode' THEN 'openrouter'
  WHEN "harness" = 'openrouter' THEN 'openrouter'
  WHEN "harness" = 'gemini' THEN 'google'
  WHEN "harness" = 'google' THEN 'google'
  ELSE 'unknown'
END
WHERE "model_provider" = '';
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.provider_credentials') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'provider_credentials_auth_type_check'
        AND conrelid = 'public.provider_credentials'::regclass
    )
  THEN
    ALTER TABLE "provider_credentials"
      ADD CONSTRAINT "provider_credentials_auth_type_check"
      CHECK ("auth_type" IN ('provider_oauth', 'byo_api_key', 'relay_managed'));
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "provider_credentials_unique_per_user";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_unique_per_workspace_key"
  ON "provider_credentials" (
    "user_id",
    "workspace_id",
    "model_provider",
    "auth_type",
    COALESCE("label", ''),
    COALESCE("key_fingerprint", '')
  );
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cloud_agents_workspace_user";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_credentials_workspace_user"
  ON "provider_credentials" ("workspace_id", "user_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cloud_agent_auth_sessions_cloud_agent";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cloud_agent_auth_sessions_user_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_cloud_agent_auth_sessions_expires_at";
--> statement-breakpoint
DROP INDEX IF EXISTS "cloud_agent_auth_sessions_sandbox_unique";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_credential_auth_sessions_credential"
  ON "provider_credential_auth_sessions" ("provider_credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_credential_auth_sessions_user_status"
  ON "provider_credential_auth_sessions" ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_provider_credential_auth_sessions_expires_at"
  ON "provider_credential_auth_sessions" ("expires_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_credential_auth_sessions_sandbox_unique"
  ON "provider_credential_auth_sessions" ("sandbox_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "harness_spend_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider_credential_id" uuid NOT NULL REFERENCES "provider_credentials"("id") ON DELETE CASCADE,
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  "model" text NOT NULL,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cache_read_tokens" integer NOT NULL DEFAULT 0,
  "cache_write_tokens" integer NOT NULL DEFAULT 0,
  "cost_usd_micros" bigint NOT NULL DEFAULT 0,
  "markup_usd_micros" bigint NOT NULL DEFAULT 0,
  "user_id" uuid NOT NULL,
  "agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "run_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_harness_spend_events_credential_time"
  ON "harness_spend_events" ("provider_credential_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_harness_spend_events_user_time"
  ON "harness_spend_events" ("user_id", "occurred_at" DESC);
--> statement-breakpoint
DO $$
BEGIN
  IF to_regclass('public.cloud_cli_bootstrap_sessions') IS NULL
    AND to_regclass('public.cli_auth_sessions') IS NOT NULL
  THEN
    ALTER TABLE "cli_auth_sessions" RENAME TO "cloud_cli_bootstrap_sessions";
  END IF;
END $$;
--> statement-breakpoint
ALTER INDEX IF EXISTS "cli_auth_sessions_sandbox_unique" RENAME TO "cloud_cli_bootstrap_sessions_sandbox_unique";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_cli_auth_sessions_user" RENAME TO "idx_cloud_cli_bootstrap_sessions_user";
--> statement-breakpoint
ALTER INDEX IF EXISTS "idx_cli_auth_sessions_expires_at" RENAME TO "idx_cloud_cli_bootstrap_sessions_expires_at";
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
        'display_name', scc."slack_channel_name"
      ),
      scc."created_at",
      scc."updated_at"
    FROM "slack_channel_configs" scc
    JOIN "workspace_integrations" wi
      ON wi."workspace_id" = scc."workspace_id"::text
      AND wi."provider" = 'slack'
      AND wi."name" IS NULL
    ON CONFLICT DO NOTHING
  $migrate$;

  EXECUTE 'DROP TABLE IF EXISTS "slack_channel_configs"';
END $$;
