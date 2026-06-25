# Trajectory: Remove mixed-case observer fallback paths

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** June 25, 2026 at 10:48 AM
> **Completed:** June 25, 2026 at 10:57 AM

---

## Summary

Removed mixed-case compatibility fallbacks in observer security paths, anchored observer token scopes through @relaycast/types with TS SDK assertions, and documented observer-token auth/scopes plus console schemas in OpenAPI.

**Approach:** Standard approach

---

## Key Decisions

### Use @relaycast/types as the observer scope anchor
- **Chose:** Use @relaycast/types as the observer scope anchor
- **Reasoning:** The engine now imports OBSERVER_SCOPES from the shared types package and the TypeScript SDK aliases observer token request/response types from Raw with compile-level assertions, so scope/filter drift fails during package builds instead of silently diverging.

---

## Chapters

### 1. Work
*Agent: default*

- Use @relaycast/types as the observer scope anchor: Use @relaycast/types as the observer scope anchor

---

## Artifacts

**Commits:** 027e212, 5e0161a
**Files changed:** 9
