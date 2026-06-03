# Trajectory: Fix preview observer dashboard workspace stream enable failure

> **Status:** ✅ Completed
> **Confidence:** 82%
> **Started:** February 18, 2026 at 10:18 PM
> **Completed:** February 18, 2026 at 10:20 PM

---

## Summary

Fixed preview observer login failures by forwarding a dedicated observer-host header from observer-router, prioritizing that header in dashboard relay URL resolution, and making workspace stream enablement best-effort during login.

**Approach:** Standard approach

---

## Key Decisions

### Make dashboard login stream-enable non-blocking and harden preview host forwarding
- **Chose:** Make dashboard login stream-enable non-blocking and harden preview host forwarding
- **Reasoning:** Preview observer traffic can lose original host context through edge/page hops, and stream toggle support may differ across backend versions; login should remain functional while preserving correct PR API routing.

---

## Chapters

### 1. Work
*Agent: default*

- Make dashboard login stream-enable non-blocking and harden preview host forwarding: Make dashboard login stream-enable non-blocking and harden preview host forwarding
