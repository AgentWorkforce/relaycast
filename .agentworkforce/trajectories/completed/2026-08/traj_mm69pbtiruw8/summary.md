# Trajectory: Implement workspace lifecycle for issue 336

> **Status:** ✅ Completed
> **Confidence:** 75%
> **Started:** August 18, 2026 at 11:33 AM
> **Completed:** August 18, 2026 at 11:48 AM

---

## Summary

Added authenticated id-scoped workspace deletion, explicit TTL creation and bounded reaping, SDK/types support, E2E TTL adoption, migration, documentation, and lifecycle/cascade tests.

Implementation commit: `c1bb456b7de57b9dbe1c9c12759a93fa977a9edf`. The trajectory records the resulting change set but does not contain trace events proving test, build, or lint execution.

**Approach:** Standard approach

---

## Key Decisions

### Implement both lifecycle halves: retain DELETE /workspace, add DELETE /workspaces/:id, and add explicit expires_at TTL reaping
- **Chose:** Implement both lifecycle halves: retain DELETE /workspace, add DELETE /workspaces/:id, and add explicit expires_at TTL reaping
- **Reasoning:** D1 enforces ON DELETE CASCADE; a nullable caller-supplied expiry is the only safe automatic deletion predicate, while names, age, message count, and agent count are ambiguous.

---

## Chapters

### 1. Work
*Agent: default*

- Implement both lifecycle halves: retain DELETE /workspace, add DELETE /workspaces/:id, and add explicit expires_at TTL reaping: Implement both lifecycle halves: retain DELETE /workspace, add DELETE /workspaces/:id, and add explicit expires_at TTL reaping
- The resulting implementation scope includes authenticated id-scoped deletion, explicit workspace expiry, bounded automatic reaping, SDK support, E2E adoption, documentation, and lifecycle tests. This trajectory does not contain trace events proving test, build, or lint execution.
