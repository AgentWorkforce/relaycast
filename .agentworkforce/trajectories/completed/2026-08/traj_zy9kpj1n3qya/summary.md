# Trajectory: Address follow-up relaycast#333 review threads

> **Status:** ✅ Completed
> **Task:** relaycast#333
> **Confidence:** 94%
> **Started:** August 18, 2026 at 10:54 AM
> **Completed:** August 18, 2026 at 10:57 AM

---

## Summary

Closed follow-up PR #333 review: mismatched workspace/channel ID conflicts now
abort atomically, while exact committed retries recover by readback; added two
rollback regressions and reran the local status-zero regression added in
`f3af1d8`. The separate injected container proof at the starting revision was
outside this trajectory.

**Approach:** Standard approach

---

## Key Decisions

### Replace idempotent no-op upserts with conflict-failing inserts
- **Chose:** Replace idempotent no-op upserts with conflict-failing inserts
- **Reasoning:** Exact lost-response recovery can be handled by validated readback after a unique conflict; allowing mismatched generated IDs to commit makes the post-commit collision check too late.

---

## Chapters

### 1. Work
*Agent: default*

- Replace idempotent no-op upserts with conflict-failing inserts: Replace idempotent no-op upserts with conflict-failing inserts
- Follow-up review reproduced both mismatched generated-ID commits, then conflict-failing inserts plus exact readback made both rollback regressions pass. The local status-zero regression from `f3af1d8` also passed; the separate injected container proof was outside this trajectory.

---

## Artifacts

**Commits:** 67e2c91
**Files changed:** 2
