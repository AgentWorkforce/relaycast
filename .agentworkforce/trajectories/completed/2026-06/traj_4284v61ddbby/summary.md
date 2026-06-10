# Trajectory: Add SDK OpenAPI sync guard

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 6, 2026 at 12:29 PM
> **Completed:** June 6, 2026 at 12:34 PM

---

## Summary

Added an SDK/OpenAPI route sync Vitest guard, fixed detected route drift in Swift and Rust SDKs, and added Python AgentClient.me()/AsyncAgentClient.me() parity with tests. Verified types, Rust, Swift, and Python test suites.

**Approach:** Standard approach

---

## Key Decisions

### Use a source-scanning OpenAPI sync test for SDK route drift
- **Chose:** Use a source-scanning OpenAPI sync test for SDK route drift
- **Reasoning:** The SDKs do not all have full parity today, so the guard checks enforceable contracts: SDKs cannot reference undocumented routes, OpenAPI routes must be represented by an SDK or explicitly exempted as protocol/internal, and core messaging routes must appear in every SDK.

---

## Chapters

### 1. Work
*Agent: default*

- Use a source-scanning OpenAPI sync test for SDK route drift: Use a source-scanning OpenAPI sync test for SDK route drift
