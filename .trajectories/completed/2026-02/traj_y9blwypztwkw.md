# Trajectory: Enhance server PostHog logging with request middleware and flush reliability

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 19, 2026 at 11:14 AM
> **Completed:** February 19, 2026 at 11:14 AM

---

## Summary

Added request logger middleware, shared logger state with child loggers, context-aware logger retrieval, and explicit flush handling for queue/scheduled paths. Logs now consistently include request metadata plus app/sdk versions and are flushed more reliably.

**Approach:** Standard approach

---

## Key Decisions

### Introduced a context-aware getRequestLogger helper and child loggers
- **Chose:** Introduced a context-aware getRequestLogger helper and child loggers
- **Reasoning:** Allows all request codepaths to share one logger instance (and pending sends) while preserving per-module source tags.

### Added logger middleware that sets request_id and flushes with waitUntil
- **Chose:** Added logger middleware that sets request_id and flushes with waitUntil
- **Reasoning:** Attaches request metadata to logs and improves reliability of asynchronous PostHog exports without delaying response delivery.

---

## Chapters

### 1. Work
*Agent: default*

- Introduced a context-aware getRequestLogger helper and child loggers: Introduced a context-aware getRequestLogger helper and child loggers
- Added logger middleware that sets request_id and flushes with waitUntil: Added logger middleware that sets request_id and flushes with waitUntil
