# Trajectory: Add E2E CI run after Cloudflare deploys

> **Status:** ✅ Completed
> **Confidence:** 92%
> **Started:** February 18, 2026 at 06:21 PM
> **Completed:** February 18, 2026 at 06:22 PM

---

## Summary

Enabled CI execution of the e2e smoke script for both preview deploys and staging deploy validation, so websocket/message-flow regressions are caught before merge and before production promotion.

**Approach:** Standard approach

---

## Key Decisions

### Run e2e smoke script in CI for preview and staging
- **Chose:** Run e2e smoke script in CI for preview and staging
- **Reasoning:** Health checks alone missed websocket/session regressions. Running scripts/e2e.ts in CI exercises registration, channels, websocket connectivity, and message flow end-to-end before merge/prod promotion.

---

## Chapters

### 1. Work
*Agent: default*

- Run e2e smoke script in CI for preview and staging: Run e2e smoke script in CI for preview and staging
