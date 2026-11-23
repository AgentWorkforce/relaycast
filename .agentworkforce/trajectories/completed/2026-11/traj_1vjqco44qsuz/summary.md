# Trajectory: Remove conformance EngineDb cast

> **Status:** ✅ Completed
> **Task:** relaycast#647 official Bun gate
> **Confidence:** 98%
> **Started:** November 10, 2026 at 07:37 AM
> **Completed:** November 10, 2026 at 07:37 AM

---

## Summary

Removed the unnecessary EngineDb cast that failed the official Bun engine boundary suite; the Bun boundary test now passes.

**Approach:** Standard approach

---

## Key Decisions

### Return the already-branded runtime database without a type assertion
- **Chose:** Return the already-branded runtime database without a type assertion
- **Reasoning:** The Node runtime exposes EngineDb through EngineDeps, and the boundary gate forbids casts outside database adapters.

---

## Chapters

### 1. Work
*Agent: default*

- Return the already-branded runtime database without a type assertion: Return the already-branded runtime database without a type assertion
