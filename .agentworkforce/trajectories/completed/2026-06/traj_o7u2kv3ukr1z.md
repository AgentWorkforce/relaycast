# Trajectory: Add durable delivery API to Rust SDK

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** June 2, 2026 at 10:52 AM
> **Completed:** June 2, 2026 at 10:56 AM

---

## Summary

Added Rust SDK durable delivery support: typed delivery models, AgentClient deliveries/ack/fail/defer helpers, delivery websocket event variants, README/changelog docs, and parity tests. Verified cargo test, cargo check, and cargo clippy --all-targets -- -D warnings.

**Approach:** Standard approach

---

## Key Decisions

### Added typed Rust delivery REST methods plus websocket delivery event variants
- **Chose:** Added typed Rust delivery REST methods plus websocket delivery event variants
- **Reasoning:** TypeScript SDK already exposed both durable delivery REST helpers and delivery event helpers; Rust parity should cover the same public surface, not only the HTTP endpoints.

---

## Chapters

### 1. Work
*Agent: default*

- Added typed Rust delivery REST methods plus websocket delivery event variants

---

## Artifacts

**Commits:** 74347eb
**Files changed:** 6
