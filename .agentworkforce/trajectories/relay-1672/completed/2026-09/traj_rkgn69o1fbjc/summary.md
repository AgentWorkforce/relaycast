# Trajectory: Make Relaycast release cleanup generation-safe

> **Status:** ✅ Completed
> **Task:** Relay #1672
> **Confidence:** 90%
> **Started:** September 6, 2026 at 08:36 AM
> **Completed:** September 6, 2026 at 09:01 AM

---

## Summary

Added SHA-256 token-generation guarded releases across Relaycast types, engine, OpenAPI, TypeScript SDK, and Rust SDK, with takeover/race regressions and atomic dispatch/completion enforcement.

**Approach:** Standard approach

---

## Key Decisions

### Use a SHA-256 token-generation verifier for release compare-and-swap
- **Chose:** Use a SHA-256 token-generation verifier for release compare-and-swap
- **Reasoning:** Relaycast takeover deliberately preserves the agent ID while rotating the credential, so the ID cannot distinguish process generations. Persisting and comparing only the token hash binds cleanup to the exact issued generation without storing or transmitting the raw token.

---

## Chapters

### 1. Work
*Agent: default*

- Use a SHA-256 token-generation verifier for release compare-and-swap: Use a SHA-256 token-generation verifier for release compare-and-swap
- Red tests reproduced stale release before dispatch and after node dispatch; exact token-hash guards now fail closed at route, dispatch, and atomic completion while legacy unguarded callers remain compatible. Full engine, package, SDK, and Rust verification is green.
