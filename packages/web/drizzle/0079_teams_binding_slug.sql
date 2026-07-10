ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "slug" text;
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "spec" jsonb;

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_slug_non_empty" CHECK (
    "slug" IS NULL OR length(btrim("slug")) > 0
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "teams" ADD CONSTRAINT "teams_spec_object_valid" CHECK (
    "spec" IS NULL OR jsonb_typeof("spec") = 'object'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "teams_workspace_slug_unique"
  ON "teams" ("workspace_id", "slug");
