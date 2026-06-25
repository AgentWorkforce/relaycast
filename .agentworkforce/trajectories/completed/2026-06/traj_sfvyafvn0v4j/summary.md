# Trajectory: Fix observer DM channel bypass

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** June 25, 2026 at 09:37 AM
> **Completed:** June 25, 2026 at 09:40 AM

---

## Summary

Fixed observer token DM channel bypass by rejecting channel_type 1/2 rows on observer channel-name routes and adding deterministic dm-* regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Reject DM-backed channels on observer channel-name routes
- **Chose:** Reject DM-backed channels on observer channel-name routes
- **Reasoning:** DM channel names are deterministic, so observer access through /channels/:name must not treat channel_type 1/2 rows as ordinary channels. DM reads stay behind dms:read and conversation filters on DM-aware endpoints.

---

## Chapters

### 1. Work
*Agent: default*

- Reject DM-backed channels on observer channel-name routes: Reject DM-backed channels on observer channel-name routes

---

## Artifacts

**Commits:** 284b6c8
**Files changed:** 4
