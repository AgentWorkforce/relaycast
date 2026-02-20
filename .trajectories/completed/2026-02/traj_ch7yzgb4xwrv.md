# Trajectory: Fix preview observer URL deployment so prNN-observer is reachable

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 18, 2026 at 09:40 PM
> **Completed:** February 18, 2026 at 09:41 PM

---

## Summary

Updated preview workflow to create/deploy observer Pages app, deploy a per-PR observer route worker, verify observer URL availability, and clean up per-PR observer worker on PR close.

**Approach:** Standard approach

---

## Key Decisions

### Provision observer Pages + per-PR observer route inside preview workflow
- **Chose:** Provision observer Pages + per-PR observer route inside preview workflow
- **Reasoning:** Removes dependency on main deploy and guarantees observer URL exists whenever preview API URL exists.

---

## Chapters

### 1. Work
*Agent: default*

- Provision observer Pages + per-PR observer route inside preview workflow: Provision observer Pages + per-PR observer route inside preview workflow
