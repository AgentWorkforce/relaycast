# Trajectory: Align Rust SDK feature parity with TypeScript SDK

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 19, 2026 at 10:18 PM
> **Completed:** February 20, 2026 at 04:51 AM

---

## Summary

Added Rust SDK parity features with TypeScript: workspace stream APIs, workspace channels/messages APIs, agent spawn/release APIs, workspace DM message listing, heartbeat/disconnect parity, origin metadata headers/query params, and relaycast.dev defaults; added parity integration tests and verified with cargo test.

**Approach:** Standard approach

---

## Key Decisions

### Prioritize endpoint and behavior parity with TypeScript SDK by adding missing Rust client methods and transport defaults, without redesigning Rust event API
- **Chose:** Prioritize endpoint and behavior parity with TypeScript SDK by adding missing Rust client methods and transport defaults, without redesigning Rust event API
- **Reasoning:** This closes user-visible feature gaps quickly while preserving Rust SDK idioms and minimizing breaking changes.

---

## Chapters

### 1. Work
*Agent: default*

- Prioritize endpoint and behavior parity with TypeScript SDK by adding missing Rust client methods and transport defaults, without redesigning Rust event API: Prioritize endpoint and behavior parity with TypeScript SDK by adding missing Rust client methods and transport defaults, without redesigning Rust event API
