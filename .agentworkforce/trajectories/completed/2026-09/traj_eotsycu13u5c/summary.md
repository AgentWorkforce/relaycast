# Trajectory: Implement crash-idempotent delegated workspace creation for relaycast #371

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** September 5, 2026 at 10:04 PM
> **Completed:** September 5, 2026 at 10:04 PM

---

## Summary

Added owner-scoped crash-idempotent delegated workspace creation with request-digest conflicts, concurrent replay recovery, HMAC-derived child credentials, atomic terminalization on delete/expiry, OpenAPI/SDK/docs, and tests. Commit 9c1c971e, PR #372.

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
- Engine and SDK implementation passed focused and full local gates; independent diff review found no plaintext credential persistence or cross-owner binding path.
