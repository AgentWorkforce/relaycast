# Trajectory: Implement crash-idempotent delegated workspace creation for relaycast #371

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 5, 2026 at 10:04 PM
> **Completed:** September 5, 2026 at 10:04 PM

---

## Summary

Recorded the decision context for the owner-scoped crash-idempotent workspace implementation in product commit `9c1c971e`. The implementation and its engine/SDK gates were PR verification completed before this trajectory began; this trajectory record was committed separately as `129ecc6` in PR #372.

**Approach:** Standard approach

---

## Key Decisions

### Use a durable owner-hash plus idempotency-key binding and request digest
- **Chose:** Use a durable owner-hash plus idempotency-key binding and request digest
- **Reasoning:** Atomic binding prevents duplicate child workspaces under concurrent requests and stable 409 conflicts protect key reuse.

### Derive child API keys with HMAC instead of persisting plaintext
- **Chose:** Derive child API keys with HMAC instead of persisting plaintext
- **Reasoning:** Replay remains usable after response loss while database compromise does not expose child bearer secrets.

---

## Chapters

### 1. Work
*Agent: default*

- Use a durable owner-hash plus idempotency-key binding and request digest: Use a durable owner-hash plus idempotency-key binding and request digest
- Derive child API keys with HMAC instead of persisting plaintext: Derive child API keys with HMAC instead of persisting plaintext
- PR verification recorded before this trajectory reported that commit `9c1c971e` passed the engine and SDK gates and an independent diff review; this trajectory itself recorded the implementation decisions after that product commit.
