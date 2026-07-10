DO $$
BEGIN
  IF to_regclass('public.provider_credentials') IS NOT NULL
  THEN
    ALTER TABLE "provider_credentials"
      ADD COLUMN IF NOT EXISTS "account_email" text;

    ALTER TABLE "provider_credentials"
      ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT false;

    -- Backfill: the most recently authenticated credential per
    -- (user, workspace, provider) group becomes the active one, matching
    -- the implicit pre-feature behavior (the last-authed payload occupies
    -- the per-provider credential-store slot).
    UPDATE "provider_credentials" pc
    SET "is_active" = true
    WHERE pc."id" IN (
      SELECT DISTINCT ON ("user_id", "workspace_id", "model_provider") "id"
      FROM "provider_credentials"
      ORDER BY
        "user_id",
        "workspace_id",
        "model_provider",
        COALESCE("last_authenticated_at", "created_at") DESC,
        "id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "provider_credentials" sibling
      WHERE sibling."user_id" = pc."user_id"
        AND sibling."workspace_id" = pc."workspace_id"
        AND sibling."model_provider" = pc."model_provider"
        AND sibling."is_active" = true
    );

    -- At most one active credential per (user, workspace, provider).
    CREATE UNIQUE INDEX IF NOT EXISTS "provider_credentials_one_active_per_provider"
      ON "provider_credentials" ("user_id", "workspace_id", "model_provider")
      WHERE "is_active";
  END IF;
END $$;
