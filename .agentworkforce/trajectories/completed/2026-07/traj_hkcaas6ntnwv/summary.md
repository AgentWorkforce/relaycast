# Trajectory: Fix GitHub issue #265 and deliver mergeable PR

> **Status:** ✅ Completed
> **Task:** #265
> **Confidence:** 95%
> **Started:** July 13, 2026 at 10:01 AM
> **Completed:** July 13, 2026 at 10:06 AM

---

## Summary

Bounded delivery TTL expiry to D1-safe batches, added large-backlog route and notice regression coverage, and updated changelogs

**Approach:** Standard approach

---

## Key Decisions

### Bound expiry cleanup to one oldest-first batch of 50 rows per read
- **Chose:** Bound expiry cleanup to one oldest-first batch of 50 rows per read
- **Reasoning:** D1 limits statements to 100 bound parameters; 50 IDs leaves room for update and predicate bindings while bounding inbox latency and preserving per-transition notices

---

## Chapters

### 1. Work
*Agent: default*

- Bound expiry cleanup to one oldest-first batch of 50 rows per read: Bound expiry cleanup to one oldest-first batch of 50 rows per read
- Implemented oldest-first 50-row expiry batches with a D1-like 100-placeholder regression; focused, engine, and monorepo gates are green

---

## Artifacts

**Commits:** 65c36c7
**Files changed:** 4
