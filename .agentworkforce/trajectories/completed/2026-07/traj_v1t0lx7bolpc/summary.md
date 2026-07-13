# Trajectory: Address final PR #266 maintenance review

> **Status:** ✅ Completed
> **Task:** PR #266
> **Confidence:** 95%
> **Started:** July 13, 2026 at 10:37 AM
> **Completed:** July 13, 2026 at 10:40 AM

---

## Summary

Added a planner-verified global partial index for active expiry batches and serialized Node HTTP-push/TTL maintenance with overlap coalescing and failure-isolation coverage.

**Approach:** Standard approach

---

## Key Decisions

### Added a global partial active-expiry index
- **Chose:** Added a global partial active-expiry index
- **Reasoning:** The scheduler sweeps across workspaces; the existing workspace-leading index cannot serve oldest-first global batches. Literal active statuses keep the SQLite partial-index predicate planner-visible.

### Serialized Node delivery maintenance
- **Chose:** Serialized Node delivery maintenance
- **Reasoning:** HTTP push dispatch must finish before TTL expiry, and overlapping timer ticks are coalesced so a slow POST cannot race a later expiry cycle.

---

## Chapters

### 1. Work
*Agent: default*

- Added a global partial active-expiry index: Added a global partial active-expiry index
- Serialized Node delivery maintenance: Serialized Node delivery maintenance

---

## Artifacts

**Commits:** 9b5913e
**Files changed:** 7
