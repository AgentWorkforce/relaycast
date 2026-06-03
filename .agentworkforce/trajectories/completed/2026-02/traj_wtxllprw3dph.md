# Trajectory: Update e2e prompt text to hosted observer dashboard

> **Status:** ✅ Completed
> **Confidence:** 97%
> **Started:** February 18, 2026 at 11:13 PM
> **Completed:** February 18, 2026 at 11:15 PM

---

## Summary

Updated scripts/e2e.ts so interactive prompt uses hosted observer dashboard URL and label for remote API bases (PR/staging/prod); local bases still show localhost dashboard.

**Approach:** Standard approach

---

## Key Decisions

### Map e2e API targets to observer dashboard URL
- **Chose:** Map e2e API targets to observer dashboard URL
- **Reasoning:** When e2e runs against preview/staging/prod APIs, the prompt should point to hosted observer domains rather than localhost to avoid confusion.

---

## Chapters

### 1. Work
*Agent: default*

- Map e2e API targets to observer dashboard URL: Map e2e API targets to observer dashboard URL
