# Trajectory: Reconcile Relaycast production maintenance APIs into main

> **Status:** ✅ Completed
> **Task:** Relaycast#415
> **Confidence:** 90%
> **Started:** September 10, 2026 at 12:32 PM
> **Completed:** September 10, 2026 at 12:36 PM

---

## Summary

Restored host-owned schema-free retention cursors and bounded WS redrive for Relaycast #415.

**Approach:** Standard approach

---

## Key Decisions

### Added an opt-in host cursor retention mode beside the 8.8 index-backed default
- **Chose:** Added an opt-in host cursor retention mode beside the 8.8 index-backed default
- **Reasoning:** Relaycast-cloud needs production's schema-free API while self-hosted 8.8 users retain durable database cursors and scheduled expiry semantics.

---

## Chapters

### 1. Work
*Agent: default*

- Added an opt-in host cursor retention mode beside the 8.8 index-backed default: Added an opt-in host cursor retention mode beside the 8.8 index-backed default
- Engine, SDK/types, release, and full lint suites passed; actionlint reports pre-existing workflow warnings outside this diff.

---

## Artifacts

**Commits:** 7bb76398
**Files changed:** 9
