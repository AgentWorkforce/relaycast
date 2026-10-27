# Trajectory: Align SDKs with SDK v8 service contract

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 2, 2026 at 10:40 PM
> **Completed:** June 2, 2026 at 10:46 PM

---

## Summary

Aligned TypeScript and Rust SDKs with SDK v8 service contract: agent-token resolve/reconnect helpers, inbound webhook token/author support, subscription headers, and Rust action.denied event coverage.

**Approach:** Standard approach

---

## Key Decisions

### Aligned SDK bindings instead of only documenting server compatibility
- **Chose:** Aligned SDK bindings instead of only documenting server compatibility
- **Reasoning:** TypeScript needed agent-token reconnect and token-aware webhook calls; Rust was missing wire fields and action.denied deserialization, so the PR would not fully satisfy SDK-facing issue coverage without SDK updates.

---

## Chapters

### 1. Work
*Agent: default*

- Aligned SDK bindings instead of only documenting server compatibility: Aligned SDK bindings instead of only documenting server compatibility
