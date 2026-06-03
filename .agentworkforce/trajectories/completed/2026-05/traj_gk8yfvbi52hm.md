# Trajectory: Fix issue 143

> **Status:** ✅ Completed
> **Task:** #143
> **Confidence:** 88%
> **Started:** May 31, 2026 at 03:03 AM
> **Completed:** May 31, 2026 at 03:12 AM

---

## Summary

Migrated @relaycast/engine platform-neutral crypto usage from node:crypto to Web Crypto helpers, keeping Node-only adapters unchanged and adding helper coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use shared Web Crypto helpers for hashing, HMAC, random hex, and UUID
- **Chose:** Use shared Web Crypto helpers for hashing, HMAC, random hex, and UUID
- **Reasoning:** This removes node:crypto from platform-neutral request paths while keeping Node adapters free to use Node builtins.

### Constrain issue 143 implementation to @relaycast/engine only
- **Chose:** Constrain issue 143 implementation to @relaycast/engine only
- **Reasoning:** The user clarified @relaycast/server is deprecated and frozen, so server changes were reverted and validation will target the engine package.

---

## Chapters

### 1. Work
*Agent: default*

- Use shared Web Crypto helpers for hashing, HMAC, random hex, and UUID: Use shared Web Crypto helpers for hashing, HMAC, random hex, and UUID
- Constrain issue 143 implementation to @relaycast/engine only: Constrain issue 143 implementation to @relaycast/engine only
