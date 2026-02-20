# Trajectory: Replace KV-backed rate limiting with Durable Object limiter

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 18, 2026 at 11:02 PM
> **Completed:** February 18, 2026 at 11:02 PM

---

## Summary

Implemented a DO-backed rate limiter (RateLimitDO), switched middleware from KV get/put to DO checks with existing in-memory fallback, added bindings/migration exports, and updated rate-limit tests and mock bindings.

**Approach:** Standard approach

---

## Key Decisions

### Move rate-limit counters to RateLimitDO instead of KV get/put
- **Chose:** Move rate-limit counters to RateLimitDO instead of KV get/put
- **Reasoning:** KV per-request writes are eventually consistent and quota-constrained; per-workspace DO counters provide stronger consistency and remove KV write amplification on hot request paths.

---

## Chapters

### 1. Work
*Agent: default*

- Move rate-limit counters to RateLimitDO instead of KV get/put: Move rate-limit counters to RateLimitDO instead of KV get/put
