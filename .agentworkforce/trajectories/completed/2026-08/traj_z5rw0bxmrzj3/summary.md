# Trajectory: Fix expired delivery backlog drain and redrive indexing

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 19, 2026 at 09:24 PM
> **Completed:** August 19, 2026 at 09:39 PM

---

## Summary

Raised expiry capacity to 2,500 deliveries per invocation with bounded 50-row D1 writes, batched failure fanout, and migration 0040's drain-first partial retry index; verified planner, full engine tests, build, and lint.

**Approach:** Standard approach

---

## Key Decisions

### Kept 50-row expiry SQL batches and bounded each sweep at 50 batches
- **Chose:** Kept 50-row expiry SQL batches and bounded each sweep at 50 batches
- **Reasoning:** A 50-row UPDATE leaves headroom under D1's 100 bound-parameter ceiling and keeps each write lock short; 2,500 rows per */5 invocation yields 720,000/day, exceeding the measured 519,000/day peak by 201,000/day.

### Batch durable failure fanout and split NULL from due-retry redrive reads
- **Chose:** Batch durable failure fanout and split NULL from due-retry redrive reads
- **Reasoning:** Fifty expiry batches would otherwise multiply D1 reads per notice and exceed the 1,000-query invocation limit. Splitting the OR query lets a small non-NULL partial index serve due retries after the backlog drains.

---

## Chapters

### 1. Work
*Agent: default*

- Kept 50-row expiry SQL batches and bounded each sweep at 50 batches: Kept 50-row expiry SQL batches and bounded each sweep at 50 batches
- Batch durable failure fanout and split NULL from due-retry redrive reads: Batch durable failure fanout and split NULL from due-retry redrive reads
- The drain, fanout batching, partial index, and query split are validated. Full engine suite passes (659 tests), build and lint pass, and EXPLAIN changes due retries from SCAN deliveries + temp B-tree to SEARCH USING idx_deliveries_retry_due.
