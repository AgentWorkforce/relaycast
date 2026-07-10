ALTER TABLE "github_clone_jobs"
  ADD COLUMN IF NOT EXISTS "materialization_json" JSONB;
