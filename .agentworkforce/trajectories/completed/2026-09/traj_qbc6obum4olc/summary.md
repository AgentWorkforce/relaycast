# Trajectory: Implement hosted-safe anonymous workspace idempotency contract for issue #407

> **Status:** ✅ Completed
> **Task:** #407
> **Confidence:** 94%
> **Started:** September 10, 2026 at 04:26 AM
> **Completed:** September 10, 2026 at 04:26 AM

---

## Summary

Implemented hosted-safe anonymous workspace idempotency with opt-in self-host proof enforcement, SDK coverage, and Docker/replay/redaction verification.

**Approach:** Standard approach

---

## Key Decisions

### Use the high-entropy anonymous Idempotency-Key as the hosted recovery capability
- **Chose:** Use the high-entropy anonymous Idempotency-Key as the hosted recovery capability
- **Reasoning:** Hosted clients cannot safely hold a deployment-wide secret; the server still needs that secret only for deterministic child API-key derivation, while opt-in self-host proof preserves the stricter deployment model.

---

## Chapters

### 1. Work
*Agent: default*

- Use the high-entropy anonymous Idempotency-Key as the hosted recovery capability: Use the high-entropy anonymous Idempotency-Key as the hosted recovery capability
