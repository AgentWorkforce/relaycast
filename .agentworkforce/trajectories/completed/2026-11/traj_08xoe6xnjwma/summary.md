# Trajectory: Add explicit strict spawn replay-resume capability

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** November 10, 2026 at 06:48 AM
> **Completed:** November 10, 2026 at 07:04 AM

---

## Summary

Added an explicit replay-resume schema and server-owned capability proof so only marked, definitely-unsent strict spawn claims can resume from persisted input; legacy claims remain lookup-only.

**Approach:** Standard approach

---

## Key Decisions

### Added a distinct logical-replay-resume schema and server-owned replay proof
- **Chose:** Added a distinct logical-replay-resume schema and server-owned replay proof
- **Reasoning:** Preserve logical/1 lookup-only semantics; only claims originally accepted under the new schema may authorize replay-side dispatch.

---

## Chapters

### 1. Work
*Agent: default*

- Added a distinct logical-replay-resume schema and server-owned replay proof: Added a distinct logical-replay-resume schema and server-owned replay proof
- Implemented explicit replay-resume schema and proof on f997; focused route, restart, isolation, concurrency, unknown-send, terminal, and generation tests pass.

---

## Artifacts

**Commits:** 183d550c
**Files changed:** 9
