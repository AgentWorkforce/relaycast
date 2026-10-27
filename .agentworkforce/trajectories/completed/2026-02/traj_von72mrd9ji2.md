# Trajectory: Auto-recover stale dashboard observer token in auth session route

> **Status:** ✅ Completed
> **Confidence:** 94%
> **Started:** February 18, 2026 at 05:36 PM
> **Completed:** February 18, 2026 at 05:36 PM

---

## Summary

Session API now self-heals observer token and rejoins channels before returning authenticated session

**Approach:** Standard approach

---

## Key Decisions

### Reissue _dashboard_observer token when session route detects invalid/expired agent token
- **Chose:** Reissue _dashboard_observer token when session route detects invalid/expired agent token
- **Reasoning:** Prevents websocket auth failures from stale cookie tokens while keeping workspace key session valid

---

## Chapters

### 1. Work
*Agent: default*

- Reissue _dashboard_observer token when session route detects invalid/expired agent token: Reissue _dashboard_observer token when session route detects invalid/expired agent token
