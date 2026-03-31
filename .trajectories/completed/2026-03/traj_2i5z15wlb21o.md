# Trajectory: Simplify SDK ensureWorkspace to rely on createWorkspace upsert behavior

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** March 31, 2026 at 03:51 PM
> **Completed:** March 31, 2026 at 03:53 PM

---

## Summary

Simplified RelayCast.ensureWorkspace to rely on createWorkspace status, removed the 409 lookup fallback, and preserved existed by mapping HTTP 200 to existing and 201 to newly created. Verified with a successful SDK TypeScript build; current relay tests still encode the old ensureWorkspace contract.

**Approach:** Standard approach

---

## Key Decisions

### Kept RelayCast.createWorkspace public return unchanged and added an internal status-aware helper for ensureWorkspace
- **Chose:** Kept RelayCast.createWorkspace public return unchanged and added an internal status-aware helper for ensureWorkspace
- **Reasoning:** This lets ensureWorkspace infer existed from HTTP 200 vs 201 without reintroducing lookup fallback or changing the createWorkspace SDK contract.

---

## Chapters

### 1. Work
*Agent: default*

- Kept RelayCast.createWorkspace public return unchanged and added an internal status-aware helper for ensureWorkspace: Kept RelayCast.createWorkspace public return unchanged and added an internal status-aware helper for ensureWorkspace
- SDK simplify change is complete; build passes and remaining relay test failures reflect stale expectations for ensureWorkspace's new 200-vs-201 behavior and removed 409 fallback.
