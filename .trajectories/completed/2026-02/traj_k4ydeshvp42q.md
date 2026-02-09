# Trajectory: PR review: optimize agent messaging (event queue/cache/ws/rate limit)

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** February 9, 2026 at 10:29 AM
> **Completed:** February 9, 2026 at 10:33 AM

---

## Summary

Reviewed PR vs main (event queue/cache/ws indexing/rate limit). Identified key edge cases: stuck 'processing' events + overlapping poller; rate-limit fallback bucket key/cleanup bugs; noted unused agent-name cache; ws indexing looks ok; tests pass but missing coverage for new queue + fallback.

**Approach:** Standard approach

---

## Key Decisions

### Rate limiter in-memory fallback should key by routeKey and update lastSeen
- **Chose:** Rate limiter in-memory fallback should key by routeKey and update lastSeen
- **Reasoning:** Fallback currently shares buckets across routes and never updates lastRefill, making enforcement inconsistent and potentially bypassable when Redis is down.

---

## Chapters

### 1. Work
*Agent: default*

- Rate limiter in-memory fallback should key by routeKey and update lastSeen: Rate limiter in-memory fallback should key by routeKey and update lastSeen
