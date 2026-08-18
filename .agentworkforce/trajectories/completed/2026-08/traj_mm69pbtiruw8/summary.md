# Trajectory: Implement workspace lifecycle for issue 336

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** August 18, 2026 at 11:33 AM
> **Completed:** August 18, 2026 at 11:48 AM

---

## Summary

Added authenticated id-scoped workspace deletion, explicit TTL creation and bounded reaping, SDK/types support, E2E TTL adoption, migration, documentation, and lifecycle/cascade tests.

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
- Implemented authenticated id-scoped deletion, explicit workspace expiry, bounded automatic reaping, SDK support, E2E adoption, docs, and cascade safety tests; full test/build/lint gates are green.
