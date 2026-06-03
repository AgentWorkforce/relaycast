# Trajectory: Make SDK origin metadata internal-only and non-configurable

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 19, 2026 at 07:10 PM
> **Completed:** February 19, 2026 at 07:12 PM

---

## Summary

Made SDK origin metadata non-configurable for users by removing public origin options and limiting origin injection to internal path; MCP now uses @relaycast/sdk/internal. Verified with SDK/MCP build and tests.

**Approach:** Standard approach

---

## Key Decisions

### MCP now imports internal factory from @relaycast/sdk/internal
- **Chose:** MCP now imports internal factory from @relaycast/sdk/internal
- **Reasoning:** Keeps origin injection internal and explicit at integration boundary without exposing it to standard SDK consumers.

---

## Chapters

### 1. Work
*Agent: default*

- MCP now imports internal factory from @relaycast/sdk/internal: MCP now imports internal factory from @relaycast/sdk/internal
