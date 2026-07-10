-- Re-asserts the github_clone_jobs schema introduced in 0021_github_clone_jobs.
--
-- Background: the production deploy of PR #397 reported "migrations applied
-- successfully" but the github_clone_jobs table is not present in prod
-- Postgres. The most likely path is that 0021's hash got stamped in
-- __drizzle_migrations during a partial earlier run without the DDL
-- executing against the prod database. Empirical signal: every POST to
-- /api/v1/github/clone/request returns HTTP 500 with an empty body, which
-- traces to the unhandled throw on findActiveGithubCloneJob's SELECT in
-- packages/web/app/api/v1/github/clone/request/route.ts:47 (no try/catch
-- wraps that call; an undefined-relation error from Postgres bubbles up
-- past the route handler and Next.js returns a synthetic empty 500).
--
-- This migration is intentionally idempotent (CREATE ... IF NOT EXISTS)
-- so it is safe on databases where 0021 actually applied AND on databases
-- where 0021 was stamped without DDL. The column set, defaults, and
-- partial-index predicate must mirror 0021 exactly so the resulting
-- schema is byte-identical regardless of which path applied it.

CREATE TABLE IF NOT EXISTS "github_clone_jobs" (
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

CREATE INDEX IF NOT EXISTS "github_clone_jobs_dedupe_idx"
  ON "github_clone_jobs" ("workspace_id", "owner", "repo", "ref", "status", "created_at")
  WHERE "status" IN ('queued', 'running');
