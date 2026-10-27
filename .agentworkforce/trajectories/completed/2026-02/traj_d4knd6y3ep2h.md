# Trajectory: Add dashboard alert and retry control for workspace stream enablement

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 10:20 PM
> **Completed:** February 18, 2026 at 10:22 PM

---

## Summary

Added /api/workspace/stream GET/PUT endpoint and dashboard warning banner with an Enable Stream button. Dashboard now detects disabled stream state and allows in-app retry to enable it.

**Approach:** Standard approach

---

## Key Decisions

### Expose workspace stream status/toggle endpoint and add dashboard-level remediation UI
- **Chose:** Expose workspace stream status/toggle endpoint and add dashboard-level remediation UI
- **Reasoning:** Stream enablement can fail at login time due backend or routing conditions, so operators need an in-app signal plus explicit retry control instead of silent degradation or hard login failure.

---

## Chapters

### 1. Work
*Agent: default*

- Expose workspace stream status/toggle endpoint and add dashboard-level remediation UI: Expose workspace stream status/toggle endpoint and add dashboard-level remediation UI
