# Trajectory: Temporarily run D1 migrations in preview workflow

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** February 18, 2026 at 04:45 PM
> **Completed:** February 18, 2026 at 04:46 PM

---

## Summary

Preview workflow now applies staging D1 migrations before deploy-worker

**Approach:** Standard approach

---

## Key Decisions

### Added temporary migration step to preview deploy job
- **Chose:** Added temporary migration step to preview deploy job
- **Reasoning:** First-run previews can fail against unmigrated shared staging DB; run migrations before deploying preview worker

---

## Chapters

### 1. Work
*Agent: default*

- Added temporary migration step to preview deploy job: Added temporary migration step to preview deploy job
