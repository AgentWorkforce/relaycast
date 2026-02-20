# Trajectory: Remove billing functionality and references from repo

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** February 20, 2026 at 03:39 PM
> **Completed:** February 20, 2026 at 03:45 PM

---

## Summary

Removed inactive billing functionality from server routes/engines/tests, SDK client/types/tests, and OpenAPI; validated with types+sdk+server build/test

**Approach:** Standard approach

---

## Key Decisions

### Remove billing from public API surface and SDK
- **Chose:** Remove billing from public API surface and SDK
- **Reasoning:** Billing is inactive; removing endpoints and client APIs avoids onboarding confusion and accidental use of unsupported functionality

### Keep historical DB migration files untouched
- **Chose:** Keep historical DB migration files untouched
- **Reasoning:** Migration history must remain immutable; billing/stripe references remain only in historical migration artifacts, not active code paths or API docs

---

## Chapters

### 1. Work
*Agent: default*

- Remove billing from public API surface and SDK: Remove billing from public API surface and SDK
- Keep historical DB migration files untouched: Keep historical DB migration files untouched
