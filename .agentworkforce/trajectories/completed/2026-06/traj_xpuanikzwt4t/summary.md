# Trajectory: Rethink Relaycast delivery adapters and first-class nodes

> **Status:** ✅ Completed
> **Confidence:** 78%
> **Started:** June 24, 2026 at 05:43 PM
> **Completed:** June 24, 2026 at 05:52 PM

---

## Summary

Reviewed Relaycast's current agent/node/delivery architecture and proposed splitting agent identity, node runtime, and delivery endpoints. Recommended an endpoint-bound durable dispatcher with adapter-specific senders for node push, HTTP push, websocket/pull, and explicit ack semantics; identified migration, state-machine, and security constraints.

**Approach:** Standard approach

---

## Key Decisions

### Separate agent identity, node runtime, and delivery endpoints for receive adapters
- **Chose:** Separate agent identity, node runtime, and delivery endpoints for receive adapters
- **Reasoning:** Current agents.location_type/location_node_id and deliveries.location_type/location_node_id mix identity, runtime placement, and transport routing; explicit receive endpoint bindings let HTTP push, node push, websocket, and pull share one durable dispatch lifecycle.

---

## Chapters

### 1. Work
*Agent: default*

- Separate agent identity, node runtime, and delivery endpoints for receive adapters: Separate agent identity, node runtime, and delivery endpoints for receive adapters
