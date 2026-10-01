# Trajectory: Validate AgentWorkforce/relaycast PR #410 release-exact idempotency and retry followups

> **Status:** ✅ Completed
> **Task:** PR-410
> **Confidence:** 92%
> **Started:** September 10, 2026 at 07:12 AM
> **Completed:** September 10, 2026 at 07:12 AM

---

## Summary

Added exact-release scope/replay docs, asserted one webhook outbox event across replay, and verified Rust caller-key preservation through a 503 retry; pushed cc6f2c38 to PR #410 branch.

**Approach:** Standard approach

---

## Key Decisions

### Documented exact-release idempotency scope and no-duplicate-webhook replay behavior
- **Chose:** Documented exact-release idempotency scope and no-duplicate-webhook replay behavior
- **Reasoning:** The route already derives a durable workspace/principal/action claim and suppresses webhook emission on replay; explicit docs and a regression test make the contract reviewable.

### Extended Rust exact-release parity test through one 503 retry
- **Chose:** Extended Rust exact-release parity test through one 503 retry
- **Reasoning:** The helper already forwards RequestOptions with the caller key; matching both attempts proves the key is preserved under bounded automatic retry.

---

## Chapters

### 1. Work
*Agent: default*

- Documented exact-release idempotency scope and no-duplicate-webhook replay behavior: Documented exact-release idempotency scope and no-duplicate-webhook replay behavior
- Extended Rust exact-release parity test through one 503 retry: Extended Rust exact-release parity test through one 503 retry
- PR #410 followups are implemented and locally validated across engine, TypeScript SDK, and Rust; hosted restart/webhook E2E remains deployment-dependent.
