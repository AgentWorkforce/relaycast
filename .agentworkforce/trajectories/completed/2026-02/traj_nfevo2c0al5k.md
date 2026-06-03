# Trajectory: Rename packages/dashboard to packages/observer-dashboard and update references

> **Status:** ✅ Completed
> **Confidence:** 98%
> **Started:** February 20, 2026 at 04:13 PM
> **Completed:** February 20, 2026 at 04:17 PM

---

## Summary

Renamed dashboard package directory to packages/observer-dashboard, removed stale packages/dashboard leftovers, updated deploy action path, and refreshed lockfile path entries. Verified with full turbo build.

**Approach:** Standard approach

---

## Key Decisions

### Renamed workspace folder from packages/dashboard to packages/observer-dashboard while keeping package name @relaycast/dashboard
- **Chose:** Renamed workspace folder from packages/dashboard to packages/observer-dashboard while keeping package name @relaycast/dashboard
- **Reasoning:** User requested directory rename; keeping package name avoids broader dependency and script churn while still changing repo structure.

---

## Chapters

### 1. Work
*Agent: default*

- Renamed workspace folder from packages/dashboard to packages/observer-dashboard while keeping package name @relaycast/dashboard: Renamed workspace folder from packages/dashboard to packages/observer-dashboard while keeping package name @relaycast/dashboard
