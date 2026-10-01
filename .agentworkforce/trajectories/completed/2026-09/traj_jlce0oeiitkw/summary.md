# Trajectory: Harden RelaycastSetup anonymous keyed workspace transport

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** September 10, 2026 at 05:18 AM
> **Completed:** September 10, 2026 at 05:21 AM

---

## Summary

Hardened RelaycastSetup anonymous keyed workspace creation with the shared HTTPS-or-loopback destination rule, manual redirects, and non-retryable redirect rejection. Added deterministic remote HTTP, cross- and same-origin redirect, loopback, authenticated, and unkeyed-control tests; audited remaining workspace-create idempotency senders.

**Approach:** Standard approach

---

## Key Decisions

### Apply anonymous keyed transport controls to RelaycastSetup
- **Chose:** Apply anonymous keyed transport controls to RelaycastSetup
- **Reasoning:** Resolve optional API credentials before classifying requests; share RelayCast destination validation; use manual redirects and treat any 3xx/opaque redirect as non-retryable so the reveal-once idempotency recovery capability never reaches a remote HTTP endpoint or redirect target.

---

## Chapters

### 1. Work
*Agent: default*

- Apply anonymous keyed transport controls to RelaycastSetup: Apply anonymous keyed transport controls to RelaycastSetup
