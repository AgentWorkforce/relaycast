# Trajectory: Add atomic Relaycast Rust SDK registration cache invalidation

> **Status:** ✅ Completed
> **Task:** relay#1969 CodeRabbit atomic cache race
> **Confidence:** 93%
> **Started:** October 13, 2026 at 05:29 AM
> **Completed:** October 13, 2026 at 05:32 AM

---

## Summary

Added atomic SHA-256-guarded registration cache invalidation with match, mismatch, cooldown, and concurrent replacement coverage.

**Approach:** Standard approach

---

## Key Decisions

### Hold token and cooldown locks through hash compare and removal
- **Chose:** Hold token and cooldown locks through hash compare and removal
- **Reasoning:** This linearizes invalidation against concurrent token seeding: replacement-first mismatches and survives; invalidation-first completes before the replacement seed.

---

## Chapters

### 1. Work
*Agent: default*

- Hold token and cooldown locks through hash compare and removal: Hold token and cooldown locks through hash compare and removal
- The SDK primitive is linearizable under replacement races; full tests pass and strict library clippy is clean. Repository-wide formatting and all-target clippy have unrelated baseline failures.
