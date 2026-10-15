# Trajectory: Bound Relaycast agent tokens with expiry and staged rotation

> **Status:** ✅ Completed
> **Task:** relayauth-shortlived
> **Confidence:** 85%
> **Started:** October 15, 2026 at 10:11 AM
> **Completed:** October 15, 2026 at 10:27 AM

---

## Summary

Added a staged 15-minute Relaycast agent-token expiry with auth enforcement, bounded rotation grace, migration, API expiry metadata, and rollout gates

**Approach:** Standard approach

---

## Key Decisions

### Keep legacy agent-token expiry NULL until holders have a rotation path
- **Chose:** Keep legacy agent-token expiry NULL until holders have a rotation path
- **Reasoning:** Immediate backfill would invalidate existing static clients after 15 minutes; the draft stays undeployable until the broker and SDK rotation rollout is reviewed.

---

## Chapters

### 1. Work
*Agent: default*

- Keep legacy agent-token expiry NULL until holders have a rotation path: Keep legacy agent-token expiry NULL until holders have a rotation path
