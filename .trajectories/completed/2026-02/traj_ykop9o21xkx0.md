# Trajectory: Fix CI health checks to use /health endpoint

> **Status:** ✅ Completed
> **Confidence:** 99%
> **Started:** February 18, 2026 at 03:37 PM
> **Completed:** February 18, 2026 at 03:37 PM

---

## Summary

Patched GitHub Actions health checks and PR comment link to /health

**Approach:** Standard approach

---

## Key Decisions

### Updated preview and smoke-test checks from /v1/health to /health
- **Chose:** Updated preview and smoke-test checks from /v1/health to /health
- **Reasoning:** Server mounts healthRoutes at /health in worker.ts; /v1/health returns 404

---

## Chapters

### 1. Work
*Agent: default*

- Updated preview and smoke-test checks from /v1/health to /health: Updated preview and smoke-test checks from /v1/health to /health
