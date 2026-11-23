# Trajectory: Return terminal strict spawn replay snapshots

> **Status:** ✅ Completed
> **Task:** relaycast#647 review feedback
> **Confidence:** 95%
> **Started:** November 10, 2026 at 07:30 AM
> **Completed:** November 10, 2026 at 07:30 AM

---

## Summary

Returned failed pre-dispatch replay-resume snapshots and added a regression that mutation-verifies the prior 503.

**Approach:** Standard approach

---

## Key Decisions

### Return terminal replay-resume claims before dispatch recovery
- **Chose:** Return terminal replay-resume claims before dispatch recovery
- **Reasoning:** Settled failed claims are immutable terminal snapshots; routing them through the live dispatcher converts their durable failure into a retryable 503.

---

## Chapters

### 1. Work
*Agent: default*

- Return terminal replay-resume claims before dispatch recovery: Return terminal replay-resume claims before dispatch recovery
