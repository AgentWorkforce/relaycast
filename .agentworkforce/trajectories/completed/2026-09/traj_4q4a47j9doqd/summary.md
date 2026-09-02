# Trajectory: Refactor: declare node delivery class in @relaycast/types and route events through one dispatcher

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** September 2, 2026 at 04:20 AM
> **Completed:** September 2, 2026 at 04:34 AM

---

## Summary

Declared NODE_DURABLE_EVENT_TYPES/nodeDeliveryClassFor in @relaycast/types, added engine/eventDispatch.ts as the single sink dispatcher, and rewired fanout.ts, deliveryRouting.ts and agent.ts onto it. Behavior preserved; 714 engine + 206 types tests green.

**Approach:** Standard approach

---

## Key Decisions

### Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
- **Chose:** Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
- **Reasoning:** The durable/ephemeral split was a hard-coded Set inside a route file and the sink fan-out was hand-assembled in fanout.ts, deliveryRouting.ts and agent.ts; one dispatcher keyed off a types-level declaration removes the drift risk while keeping nodeContext.ts as the transport layer

---

## Chapters

### 1. Work
*Agent: default*

- Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts: Declared the node delivery class in @relaycast/types and funneled all event fan-out through engine/eventDispatch.ts
