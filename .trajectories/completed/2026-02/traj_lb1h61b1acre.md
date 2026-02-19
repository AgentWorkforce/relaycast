# Trajectory: Harden preview environment cleanup on PR close/merge

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 19, 2026 at 01:19 AM
> **Completed:** February 19, 2026 at 01:20 AM

---

## Summary

Updated preview cleanup to run on PR close (merged or not) and delete both preview workers in a single idempotent step so cleanup continues even if a worker is already missing

**Approach:** Standard approach

---

## Key Decisions

### Make preview cleanup idempotent for merged/closed PRs
- **Chose:** Make preview cleanup idempotent for merged/closed PRs
- **Reasoning:** Current cleanup can stop after first failed delete, leaving observer preview worker undeleted; a single guarded cleanup script should attempt both resources on every PR close (merged or not).

---

## Chapters

### 1. Work
*Agent: default*

- Make preview cleanup idempotent for merged/closed PRs: Make preview cleanup idempotent for merged/closed PRs
