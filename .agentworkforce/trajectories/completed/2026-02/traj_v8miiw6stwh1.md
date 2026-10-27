# Trajectory: Add explicit CI validation for missing D1/KV IDs in deploy action

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** February 18, 2026 at 09:21 AM
> **Completed:** February 18, 2026 at 09:22 AM

---

## Summary

Updated deploy-worker action to validate non-empty d1-database-id/kv-id before generating config and emit clear instructions when vars are missing.

**Approach:** Standard approach

---

## Key Decisions

### Fail deploy action early when D1/KV IDs are empty
- **Chose:** Fail deploy action early when D1/KV IDs are empty
- **Reasoning:** Preview deploy received empty kv-id from GitHub vars, producing Wrangler config parse error; explicit validation gives immediate actionable feedback.

---

## Chapters

### 1. Work
*Agent: default*

- Fail deploy action early when D1/KV IDs are empty: Fail deploy action early when D1/KV IDs are empty
