# Trajectory: Stop noisy scheduled idempotency cleanup warnings

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** February 19, 2026 at 10:07 PM
> **Completed:** February 19, 2026 at 10:08 PM

---

## Summary

Removed stale scheduled D1 cleanup for idempotency_keys; idempotency now uses KV TTL so hourly DELETE was failing and generating warn logs

**Approach:** Standard approach

---

## Key Decisions

### Remove scheduled D1 idempotency cleanup query and make scheduled handler a no-op
- **Chose:** Remove scheduled D1 idempotency cleanup query and make scheduled handler a no-op
- **Reasoning:** Idempotency storage is KV with TTL and no idempotency_keys table exists in D1, so hourly DELETE fails and creates noisy production warnings

---

## Chapters

### 1. Work
*Agent: default*

- Remove scheduled D1 idempotency cleanup query and make scheduled handler a no-op: Remove scheduled D1 idempotency cleanup query and make scheduled handler a no-op
