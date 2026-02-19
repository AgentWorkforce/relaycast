# Trajectory: Fix stale online status in dashboard activity feed after disconnect

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 17, 2026 at 09:22 PM
> **Completed:** February 17, 2026 at 09:22 PM

---

## Summary

Updated dashboard /api/activity to derive online/offline from relay.agents.presence() (with fallback to list status), eliminating stale 'is online' activity entries after disconnect. Verified with next build.

**Approach:** Standard approach

---

## Key Decisions

### Activity poller should source status from relay.agents.presence() instead of relay.agents.list()
- **Chose:** Activity poller should source status from relay.agents.presence() instead of relay.agents.list()
- **Reasoning:** agents.list() reflects DB status and can lag real disconnect state; presence endpoint is DO-backed real-time truth used by e2e disconnect checks.

---

## Chapters

### 1. Work
*Agent: default*

- Activity poller should source status from relay.agents.presence() instead of relay.agents.list(): Activity poller should source status from relay.agents.presence() instead of relay.agents.list()
