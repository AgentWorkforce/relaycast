CREATE TABLE "github_clone_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" TEXT NOT NULL,
  "owner" TEXT NOT NULL,
  "repo" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "connection_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "files_written" INTEGER,
  "head_sha" TEXT,
  "duration_ms" INTEGER,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "github_clone_jobs_dedupe_idx"
  ON "github_clone_jobs" ("workspace_id", "owner", "repo", "ref", "status", "created_at")
  WHERE "status" IN ('queued', 'running');
