# Trajectory: Fix PR observer 404 by targeting PR Pages branch and setting nodejs_compat flags

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 10:00 PM
> **Completed:** February 18, 2026 at 10:01 PM

---

## Summary

Updated preview/deploy workflows to enforce nodejs_compat for Pages and route prNN-observer to pr-NN Pages deployment origin, fixing observer 404/503 failures.

**Approach:** Standard approach

---

## Key Decisions

### Set observer PR router origin to PR-specific Pages domain
- **Chose:** Set observer PR router origin to PR-specific Pages domain
- **Reasoning:** prNN-observer route previously proxied to production Pages hostname, causing Deployment Not Found for preview URLs.

### Patch Pages project deployment configs to include nodejs_compat
- **Chose:** Patch Pages project deployment configs to include nodejs_compat
- **Reasoning:** next-on-pages output requires nodejs_compat in both preview and production envs; automation avoids manual dashboard toggling and recurring 503 runtime errors.

---

## Chapters

### 1. Work
*Agent: default*

- Set observer PR router origin to PR-specific Pages domain: Set observer PR router origin to PR-specific Pages domain
- Patch Pages project deployment configs to include nodejs_compat: Patch Pages project deployment configs to include nodejs_compat
