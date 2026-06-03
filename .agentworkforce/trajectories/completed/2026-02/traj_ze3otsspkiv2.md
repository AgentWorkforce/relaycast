# Trajectory: Wave 12: Create Fly.io deploy configuration

> **Status:** ✅ Completed
> **Task:** Wave-12
> **Confidence:** 86%
> **Started:** February 8, 2026 at 01:06 AM
> **Completed:** February 8, 2026 at 01:09 AM

---

## Summary

Added Fly.io deploy config (deploy/fly.toml), production-ready Dockerfile, and deployment helper scripts/docs under deploy/ (ENV.md, scripts/*.sh). Scripts are executable and Dockerfile uses Alpine-compatible non-root user creation plus HEALTHCHECK.

**Approach:** Standard approach

---

## Key Decisions

### Used Alpine BusyBox adduser/addgroup flags instead of --system/--uid/--gid
- **Chose:** Used Alpine BusyBox adduser/addgroup flags instead of --system/--uid/--gid
- **Reasoning:** node:20-alpine images ship BusyBox adduser/addgroup which do not support GNU-style long flags; using -S/-u/-g keeps non-root user creation working.

### Kept Fly config exactly as provided (http_service + services + health check)
- **Chose:** Kept Fly config exactly as provided (http_service + services + health check)
- **Reasoning:** Followed task spec verbatim to match expected Fly runtime routing and /health HTTP check.

---

## Chapters

### 1. Work
*Agent: default*

- Used Alpine BusyBox adduser/addgroup flags instead of --system/--uid/--gid: Used Alpine BusyBox adduser/addgroup flags instead of --system/--uid/--gid
- Kept Fly config exactly as provided (http_service + services + health check): Kept Fly config exactly as provided (http_service + services + health check)
