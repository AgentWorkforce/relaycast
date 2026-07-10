-- #1516 Bug 1: cooldown trailing edge. When a PR-context dispatch is suppressed
-- by the 180s issue-dispatch cooldown, the within-window event was previously
-- DROPPED with no coalesced re-fire, so a reviewer commenting inside the window
-- (e.g. cubic, the slowest reviewer) was permanently lost. These nullable
-- columns let a suppressed dispatch record exactly ONE pending re-dispatch
-- (latest within-window payload wins); a sweep re-fires it once after the
-- window expires. Additive + backward-safe: existing INSERT/UPDATE/SELECT paths
-- do not reference these columns, and they default NULL.
ALTER TABLE "integration_watch_issue_dispatch_dedup"
  ADD COLUMN IF NOT EXISTS "pending_delivery_id" text;

ALTER TABLE "integration_watch_issue_dispatch_dedup"
  ADD COLUMN IF NOT EXISTS "pending_payload" jsonb;
