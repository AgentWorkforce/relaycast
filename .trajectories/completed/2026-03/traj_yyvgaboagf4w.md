# Trajectory: Fix failing SDK workspace tests for idempotent create behavior

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** March 31, 2026 at 04:01 PM
> **Completed:** March 31, 2026 at 04:05 PM

---

## Summary

Updated SDK workspace-create tests for idempotent 200 responses and made api_key optional in the shared create-workspace schema.

**Approach:** Standard approach

---

## Key Decisions

### Make SDK create-workspace response accept idempotent 200 payloads without api_key and update tests to assert 201=create, 200=existing
- **Chose:** Make SDK create-workspace response accept idempotent 200 payloads without api_key and update tests to assert 201=create, 200=existing
- **Reasoning:** Server now returns 200 for duplicate-name creates instead of 409, and existing workspace keys are not recoverable on that path.

---

## Chapters

### 1. Work
*Agent: default*

- Make SDK create-workspace response accept idempotent 200 payloads without api_key and update tests to assert 201=create, 200=existing: Make SDK create-workspace response accept idempotent 200 payloads without api_key and update tests to assert 201=create, 200=existing
