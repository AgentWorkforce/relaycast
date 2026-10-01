# Trajectory: Implement Relaycast #409 atomic exact-agent release contract

> **Status:** ✅ Completed
> **Task:** relaycast#409
> **Confidence:** 88%
> **Started:** September 10, 2026 at 06:09 AM
> **Completed:** September 10, 2026 at 06:12 AM

---

## Summary

Added exact immutable-agent release route, keyed idempotency replay, overload retry timing, and TypeScript/Rust SDK parity with race tests.

**Approach:** Standard approach

---

## Key Decisions

### Use a separate exact release route
- **Chose:** Use a separate exact release route
- **Reasoning:** Keeps legacy name-addressed release backwards compatible while requiring immutable identity and a durable caller key for reconciliation.

---

## Chapters

### 1. Work
*Agent: default*

- Use a separate exact release route: Use a separate exact release route
- Engine, TypeScript SDK, and Rust SDK now share the exact-release contract; full engine suite and focused SDK tests are green.
