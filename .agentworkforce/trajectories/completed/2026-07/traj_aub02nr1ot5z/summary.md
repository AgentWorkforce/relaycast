# Trajectory: Decouple delivery expiry cleanup from inbox reads

> **Status:** ✅ Completed
> **Task:** PR #266
> **Confidence:** 95%
> **Started:** July 13, 2026 at 10:18 AM
> **Completed:** July 13, 2026 at 10:22 AM

---

## Summary

Decoupled delivery expiry from inbox reads, added a bounded global scheduled sweeper for Node and cron adapters, documented the contract, and verified cleanup failures cannot break reads

**Approach:** Standard approach

---

## Key Decisions

### Make scheduled maintenance the sole owner of delivery expiry transitions
- **Chose:** Make scheduled maintenance the sole owner of delivery expiry transitions
- **Reasoning:** Mailbox reads must remain latency- and failure-independent from cleanup; default reads filter unswept expired rows while a bounded global sweep preserves dead-letter state and sender notices

---

## Chapters

### 1. Work
*Agent: default*

- Make scheduled maintenance the sole owner of delivery expiry transitions: Make scheduled maintenance the sole owner of delivery expiry transitions
- Read paths are now pure, Node schedules expiry every 15 seconds, cron adapters receive an exported sweep helper, and failure-isolation plus 121-row D1 regressions pass

---

## Artifacts

**Commits:** b136358
**Files changed:** 11
