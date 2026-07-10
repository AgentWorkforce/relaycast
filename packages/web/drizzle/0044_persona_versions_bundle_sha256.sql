-- Cold-start runtime (cloud#604+) needs the persona's deploy bundle
-- (runner.mjs + agent.bundle.mjs + package.json) to be retrievable
-- when the tick handler provisions a sandbox on-demand at trigger fire.
--
-- Bundle bytes live in S3 under `WorkflowStorage` keyed by SHA256:
--   s3://<workflowStorage>/persona-bundles/<sha256>.json
--
-- This migration adds the content-addressed pointer column. Nullable
-- because pre-cold-start `persona_versions` rows have no bundle (the
-- bundle was uploaded straight to a Daytona sandbox at deploy time and
-- never persisted). Those rows can never satisfy a cold-start tick; on
-- the first deploy of an existing persona under cold-start the row is
-- upserted with the bundle hash and old tombstone rows can be cleared
-- in a follow-up GC.
ALTER TABLE "persona_versions"
  ADD COLUMN IF NOT EXISTS "bundle_sha256" text;
