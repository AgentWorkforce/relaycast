# Trajectory: Address PR 214 review comments

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 25, 2026 at 06:27 AM
> **Completed:** June 25, 2026 at 06:33 AM

---

## Summary

Addressed PR #214 review feedback by enforcing direct-node capacity, removing the static OpenAPI role default, and translating implicit direct-node deliver frames back to client realtime events.

**Approach:** Standard approach

---

## Key Decisions

### Kept ws.node.v1 as the durable route but translated implicit direct-node deliver frames back to client events
- **Chose:** Kept ws.node.v1 as the durable route but translated implicit direct-node deliver frames back to client events
- **Reasoning:** Broker nodes need node protocol frames, while ordinary agent /v1/ws clients and SDK subscriptions rely on canonical typed realtime events.

---

## Chapters

### 1. Work
*Agent: default*

- Kept ws.node.v1 as the durable route but translated implicit direct-node deliver frames back to client events: Kept ws.node.v1 as the durable route but translated implicit direct-node deliver frames back to client events

---

## Artifacts

**Commits:** d970f57
**Files changed:** 7
