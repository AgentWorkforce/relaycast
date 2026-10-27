# Trajectory: Remove billing SDK surface from Python SDK

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** February 20, 2026 at 07:55 PM
> **Completed:** February 20, 2026 at 07:57 PM

---

## Summary

Removed billing SDK support from packages/sdk-python by deleting billing client/module and related models, updating Relay/AsyncRelay and package exports, and removing billing-related tests. Python SDK test suite passes.

**Approach:** Standard approach

---

## Key Decisions

### Removed billing from Python SDK public surface
- **Chose:** Removed billing from Python SDK public surface
- **Reasoning:** Billing is inactive and should not appear in SDK APIs. Removed relay.billing namespaces, billing module exports, and billing data models to avoid confusion.

### Pruned billing-specific tests instead of preserving stubs
- **Chose:** Pruned billing-specific tests instead of preserving stubs
- **Reasoning:** Keeping stubs would imply supported functionality. Deleting billing tests enforces that billing is no longer part of supported SDK behavior.

---

## Chapters

### 1. Work
*Agent: default*

- Removed billing from Python SDK public surface: Removed billing from Python SDK public surface
- Pruned billing-specific tests instead of preserving stubs: Pruned billing-specific tests instead of preserving stubs
