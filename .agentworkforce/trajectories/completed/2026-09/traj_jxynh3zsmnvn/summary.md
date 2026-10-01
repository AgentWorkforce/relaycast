# Trajectory: Repair NPM release workflow source-tree SHA regression

> **Status:** ✅ Completed
> **Task:** Fix truncated immutable source-tree SHA handling in repair workflow; canonical source tree is 3ea102dfb9622e3cc2819feb0cdf202cc029c8e6
> **Confidence:** 93%
> **Started:** September 10, 2026 at 10:34 AM
> **Completed:** September 10, 2026 at 10:38 AM

---

## Summary

Canonicalized the NPM repair workflow's source tree from the allow-listed source commit and added exact-SHA regression coverage for the workflow default and fixture.

**Approach:** Standard approach

---

## Key Decisions

### Resolve sourceTree from the allow-listed source commit before repair validation
- **Chose:** Resolve sourceTree from the allow-listed source commit before repair validation
- **Reasoning:** The failed run supplied a 39-character source-tree input even though the repository default and fixture were canonical; deriving the tree from the immutable source commit removes manual truncation risk while existing fixture and provenance checks remain authoritative.

---

## Chapters

### 1. Work
*Agent: default*

- Resolve sourceTree from the allow-listed source commit before repair validation: Resolve sourceTree from the allow-listed source commit before repair validation
- The repair workflow now canonicalizes source-tree identity before both validation stages, and release regression coverage pins the exact 40-character SHA across workflow and fixture.
