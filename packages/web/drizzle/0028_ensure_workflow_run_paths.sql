-- Re-asserts the workflow_runs.paths and workflow_runs.pushed_to columns
-- introduced in 0026_workflow_run_paths.sql and 0027_workflow_run_path_pushed_to.sql.
--
-- Background: the production deploy of PR #418 (commit 7715c3c5) reported
-- "migrations applied successfully" at 2026-05-04T10:00:49Z but the
-- workflow_runs.paths column is not present in the prod app database.
-- The new lambda code (LastModified 2026-05-04T10:00:22Z, from #303 phase C
-- push-back) writes `paths` and `pushed_to` on every workflow run, so every
-- POST to /api/v1/workflows/run now returns 500 with `{"error":"internal"}`.
-- The CloudWatch trace shows pg error 42703 (`column "paths" does not exist`)
-- on the workflow_runs INSERT.
--
-- Most likely path: the cancelled deploy runs for #296/#302/#303 stamped
-- migration hashes for 0025/0026/0027 into __drizzle_migrations on the
-- prod database without the DDL committing, so drizzle-kit treated those
-- migrations as already-applied and skipped them on the #418 deploy. This
-- is the same failure mode that 0022_ensure_github_clone_jobs.sql was
-- written to recover from after PR #397.
--
-- This migration is intentionally idempotent (ADD COLUMN IF NOT EXISTS)
-- so it is safe on databases where 0026/0027 actually applied AND on
-- databases where they were stamped without DDL. The column types must
-- mirror 0026 and 0027 exactly so the resulting schema is byte-identical
-- regardless of which path applied it.

ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "paths" jsonb;
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "pushed_to" jsonb;
