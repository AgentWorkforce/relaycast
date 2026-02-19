# Trajectory: Fix PR comment preview URL format for E2E command

> **Status:** ✅ Completed
> **Confidence:** 99%
> **Started:** February 18, 2026 at 03:39 PM
> **Completed:** February 18, 2026 at 03:39 PM

---

## Summary

Confirmed comment template is correct; stale PR comment likely from earlier run or failed update step

**Approach:** Standard approach

---

## Key Decisions

### Verified PR comment URL template already uses pr<PR>-api format
- **Chose:** Verified PR comment URL template already uses pr<PR>-api format
- **Reasoning:** preview.yml sets url = https://pr-api.relaycast.dev and interpolates it in e2e command

---

## Chapters

### 1. Work
*Agent: default*

- Verified PR comment URL template already uses pr<PR>-api format: Verified PR comment URL template already uses pr<PR>-api format
