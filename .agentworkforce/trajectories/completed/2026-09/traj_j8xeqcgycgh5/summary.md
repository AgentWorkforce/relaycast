# Trajectory: Add Rust self-host bootstrap proof parity for Relaycast #407

> **Status:** ✅ Completed
> **Task:** #407
> **Confidence:** 94%
> **Started:** September 10, 2026 at 04:34 AM
> **Completed:** September 10, 2026 at 04:40 AM

---

## Summary

Added Rust opt-in self-host bootstrap proof parity with hosted-safe omission, destination/redirect protections, redaction, docs, and wire-level tests.

**Approach:** Standard approach

---

## Key Decisions

### Rust bootstrap proof remains opt-in and destination-bound
- **Chose:** Rust bootstrap proof remains opt-in and destination-bound
- **Reasoning:** Hosted callers use only a high-entropy idempotency key; the proof is forwarded solely for keyed explicit self-host HTTPS or loopback HTTP, never hosted or redirects.

---

## Chapters

### 1. Work
*Agent: default*

- Rust bootstrap proof remains opt-in and destination-bound: Rust bootstrap proof remains opt-in and destination-bound
