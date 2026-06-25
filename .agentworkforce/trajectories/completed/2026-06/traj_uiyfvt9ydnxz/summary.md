# Trajectory: Address second observer token review pass

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 25, 2026 at 09:09 AM
> **Completed:** June 25, 2026 at 09:25 AM

---

## Summary

Addressed observer token review feedback: centralized dms:read plus include_dms enforcement, filtered console aggregates, preserved stream timestamps and ids for observer filtering, returned 409 for duplicate token names, updated docs, and verified engine tests/lint/build.

**Approach:** Standard approach

---

## Key Decisions

### Require both dms:read and include_dms for observer DM content
- **Chose:** Require both dms:read and include_dms for observer DM content
- **Reasoning:** Scopes should grant capabilities while filters narrow resources; treating include_dms alone as a capability let DM bodies leak through search/activity/stream paths.

### Reuse filtered message logs for observer console aggregates
- **Chose:** Reuse filtered message logs for observer console aggregates
- **Reasoning:** Console aggregate endpoints need the same observer filter semantics as /console/messages; aggregating visible logs avoids a second SQL permission implementation with divergent DM/channel/agent behavior.

---

## Chapters

### 1. Work
*Agent: default*

- Require both dms:read and include_dms for observer DM content: Require both dms:read and include_dms for observer DM content
- Reuse filtered message logs for observer console aggregates: Reuse filtered message logs for observer console aggregates

---

## Artifacts

**Commits:** d33cff1
**Files changed:** 10
