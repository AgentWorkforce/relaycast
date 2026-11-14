# Trajectory: Release unready strict-spawn capacity reservation

> **Status:** ✅ Completed
> **Task:** relaycast#644 discussion_r4526195204
> **Confidence:** 94%
> **Started:** November 10, 2026 at 07:44 AM
> **Completed:** November 10, 2026 at 07:46 AM

---

## Summary

Released false-ready unsent strict-spawn reservations while preserving exact placement tokens; added same-key reconnect regression and captured mutation fail/pass evidence.

**Approach:** Standard approach

---

## Key Decisions

### Release unsent strict reservations on every unready return, not only verify_ready refusals
- **Chose:** Release unsent strict reservations on every unready return, not only verify_ready refusals
- **Reasoning:** A false-ready request returns pending without dispatch; keeping its capacity reservation until the 72-hour expiry can starve a small node. The exact placement token remains durable, so a same-key retry can atomically reacquire capacity on the same node without weakening exact-node binding.

---

## Chapters

### 1. Work
*Agent: default*

- Release unsent strict reservations on every unready return, not only verify_ready refusals: Release unsent strict reservations on every unready return, not only verify_ready refusals
