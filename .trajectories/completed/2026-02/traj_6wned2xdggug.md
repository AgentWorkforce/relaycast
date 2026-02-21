# Trajectory: Workspace eviction: two-phase soft delete + hard delete

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 21, 2026 at 11:36 AM
> **Completed:** February 21, 2026 at 11:37 AM

---

## Summary

Implemented two-phase workspace eviction: soft delete (suspend) at 30 days, hard delete with R2 cleanup at 60 days. Fixed activity tracking gaps in requireWorkspaceKey and requireAgentToken middleware.

**Approach:** Schema-first: added suspendedAt column, updated migration SQL, rewrote eviction engine with suspend/evict/purge functions, patched auth middleware, updated cron handler. Fixed test mocks for new fields.

---

## Chapters

### 1. Work
*Agent: default*

- Two-phase eviction: suspend at 30 days inactivity (soft delete), hard delete at 60 days (30 days after suspend). This replaces the single-pass hard delete at 30 days.: Two-phase eviction: suspend at 30 days inactivity (soft delete), hard delete at 60 days (30 days after suspend). This replaces the single-pass hard delete at 30 days.
- Added suspendedAt column to workspaces table. touchWorkspaceActivity now clears suspendedAt to revive suspended workspaces on any activity.: Added suspendedAt column to workspaces table. touchWorkspaceActivity now clears suspendedAt to revive suspended workspaces on any activity.
- Added touchWorkspaceActivity to requireWorkspaceKey and requireAgentToken middleware (debounced, fire-and-forget) to fix missing activity tracking on those auth paths.: Added touchWorkspaceActivity to requireWorkspaceKey and requireAgentToken middleware (debounced, fire-and-forget) to fix missing activity tracking on those auth paths.
- R2 cleanup before hard delete: purgeWorkspaceR2 lists objects with workspace prefix and deletes in batches. Runs per-workspace during eviction phase 2.: R2 cleanup before hard delete: purgeWorkspaceR2 lists objects with workspace prefix and deletes in batches. Runs per-workspace during eviction phase 2.
- All changes implemented and verified. Build passes, all 349 tests pass. Files modified: schema.ts (added suspendedAt), 0002_workspace_eviction.sql (added suspended_at column + index), eviction.ts (rewritten with two-phase logic + R2 cleanup), auth.ts (added touch to requireWorkspaceKey and requireAgentToken), worker.ts (updated cron to call both phases), test-helpers.ts and auth.test.ts (added lastActivityAt/suspendedAt to mocks).
