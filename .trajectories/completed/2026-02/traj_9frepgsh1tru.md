# Trajectory: Make workspace streaming default-off and avoid login/logout KV churn

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 18, 2026 at 11:06 PM
> **Completed:** February 18, 2026 at 11:07 PM

---

## Summary

Kept workspace stream default disabled and removed dashboard login/logout stream.set calls to reduce KV churn; stream can now only be changed via explicit workspace stream endpoint/UI.

**Approach:** Standard approach

---

## Key Decisions

### Removed auth-time workspace stream toggles
- **Chose:** Removed auth-time workspace stream toggles
- **Reasoning:** Login/logout should not mutate workspace stream state; this avoids unnecessary KV reads/writes and leaves stream changes to explicit dashboard controls.

---

## Chapters

### 1. Work
*Agent: default*

- Removed auth-time workspace stream toggles: Removed auth-time workspace stream toggles
