-- Adds the columns needed for incremental clone sync (webhook-driven git-pull).
-- See specs/sage-anti-fabrication-pipeline.md §clone-status for the broader
-- design. The `mode` column distinguishes a full clone (existing tarball
-- pipeline) from an incremental sync (compare base..head + per-file blob
-- writes via Relayfile.bulkWrite/deleteFile). `base_sha` carries the prior
-- head when `mode = 'incremental'`; for `mode = 'full'` it is NULL.
--
-- Idempotent on purpose: 0021 / 0022 are deployed unevenly across envs
-- (see comment header in 0022_ensure_github_clone_jobs.sql), so we mirror
-- that posture here.
--
-- Rollback (manual):
--   ALTER TABLE "github_clone_jobs" DROP COLUMN IF EXISTS "base_sha";
--   ALTER TABLE "github_clone_jobs" DROP COLUMN IF EXISTS "mode";

ALTER TABLE "github_clone_jobs"
  ADD COLUMN IF NOT EXISTS "mode" varchar(16) NOT NULL DEFAULT 'full';

ALTER TABLE "github_clone_jobs"
  ADD COLUMN IF NOT EXISTS "base_sha" varchar(40);
