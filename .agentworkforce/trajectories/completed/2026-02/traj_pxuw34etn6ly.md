# Trajectory: Automate D1 migrations in deploy workflow

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 18, 2026 at 03:42 PM
> **Completed:** February 18, 2026 at 03:42 PM

---

## Summary

Deploy workflow now applies D1 migrations using temp wrangler configs with DB IDs from GitHub vars

**Approach:** Standard approach

---

## Key Decisions

### Added staging/prod migration apply steps before worker deploy
- **Chose:** Added staging/prod migration apply steps before worker deploy
- **Reasoning:** Prevents runtime schema mismatches where code expects newer columns than remote D1 schema

---

## Chapters

### 1. Work
*Agent: default*

- Added staging/prod migration apply steps before worker deploy: Added staging/prod migration apply steps before worker deploy
