# Trajectory: Fix server tests failing on Node SQLite fake D1

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** April 17, 2026 at 11:19 AM
> **Completed:** April 17, 2026 at 11:31 AM

---

## Summary

Fixed Node 22.14 server test failures by centralizing fake D1, adding raw array compatibility and FTS fallback, and pinning shared CI setup to publish Node version.

**Approach:** Standard approach

---

## Key Decisions

### Centralized fake D1 test harness with Node 22.14 compatibility
- **Chose:** Centralized fake D1 test harness with Node 22.14 compatibility
- **Reasoning:** The failing suites duplicated a fake D1 implementation that assumed node:sqlite setReturnArrays and FTS5. A shared helper keeps Drizzle raw row mapping and directory FTS fallback consistent across directory, routing, and workspace engine tests.

### Pinned shared CI setup to Node 22.14.0
- **Chose:** Pinned shared CI setup to Node 22.14.0
- **Reasoning:** Publish workflow is pinned to Node 22.14.0 while CI used floating Node 22, so PR CI could run on a newer patch with SQLite FTS5 and setReturnArrays and miss publish failures.

---

## Chapters

### 1. Work
*Agent: default*

- Centralized fake D1 test harness with Node 22.14 compatibility: Centralized fake D1 test harness with Node 22.14 compatibility
- Pinned shared CI setup to Node 22.14.0: Pinned shared CI setup to Node 22.14.0
