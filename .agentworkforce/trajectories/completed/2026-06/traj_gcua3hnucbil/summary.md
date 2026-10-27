# Trajectory: Address node delivery review follow-up

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** June 24, 2026 at 11:27 PM
> **Completed:** June 24, 2026 at 11:39 PM

---

## Summary

Addressed PR review follow-up for node delivery: exported and documented HTTP push redrive scheduling, moved mute filtering into the delivery-write path, made HTTP redrive claims compare against observed next_attempt_at, stopped direct_ws creation from clobbering explicit node bindings, and moved binding workspace constraints into a new 0024 migration. Validated with JS workspace lint/test/build plus Rust, Swift, and Python SDK tests.

**Approach:** Standard approach

---

## Key Decisions

### Addressed delivery review by moving guarantees into the production route
- **Chose:** Addressed delivery review by moving guarantees into the production route
- **Reasoning:** HTTP push retries are exported for hosted schedulers, mute filtering now happens when delivery rows/outcomes are built, redrive claims compare against the observed next_attempt_at, and direct_ws creation no longer clobbers explicit node bindings.

---

## Chapters

### 1. Work
*Agent: default*

- Addressed delivery review by moving guarantees into the production route: Addressed delivery review by moving guarantees into the production route

---

## Artifacts

**Commits:** 2f0c3ad
**Files changed:** 12
