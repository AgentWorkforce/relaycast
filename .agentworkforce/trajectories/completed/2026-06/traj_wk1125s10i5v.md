# Trajectory: Satisfy GitHub issue #158

> **Status:** ✅ Completed
> **Task:** #158
> **Confidence:** 90%
> **Started:** June 2, 2026 at 10:07 PM
> **Completed:** June 2, 2026 at 10:25 PM

---

## Summary

Implemented issue #158 SDK v8 service contract: agent self lookup, action available_to filtering/enforcement and events, authenticated inbound webhooks with message/author support, subscription headers/HMAC docs, and canonical realtime/subscription event names across SDK consumers.

**Approach:** Standard approach

---

## Key Decisions

### Implemented SDK v8 contract in engine and event vocabulary
- **Chose:** Implemented SDK v8 contract in engine and event vocabulary
- **Reasoning:** Issue #158 requires agent-token reconnect, duplicate rejection confirmation, action available_to enforcement/discovery, authenticated inbound webhooks, subscription headers/HMAC docs, and canonical dotted event names across realtime and subscriptions.

---

## Chapters

### 1. Work
*Agent: default*

- Implemented SDK v8 contract in engine and event vocabulary: Implemented SDK v8 contract in engine and event vocabulary
