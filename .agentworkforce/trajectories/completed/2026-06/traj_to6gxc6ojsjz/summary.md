# Trajectory: Implement first-class node delivery contracts

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 24, 2026 at 07:07 PM
> **Completed:** June 24, 2026 at 07:21 PM

---

## Summary

Implemented first-class node delivery contracts: nodes now carry kind and delivery adapter config, agents can be explicitly bound to nodes, HTTP push nodes support bearer/static header/HMAC auth and ack modes, delivery rows record route and dispatch metadata, SDK/OpenAPI/README document the new surface, and conformance tests cover HMAC push, on-2xx ack, capacity defaults, and existing delivery rerouting semantics.

**Approach:** Standard approach

---

## Key Decisions

### Modeled HTTP push as a node kind with a delivery contract
- **Chose:** Modeled HTTP push as a node kind with a delivery contract
- **Reasoning:** A remote HTTP endpoint is a delivery host for one or more agents, so binding agents to first-class nodes keeps fleet WebSocket, HTTP push, and future adapters behind one routing model while allowing per-node auth and ack requirements.

### Agent row remains the current-location authority
- **Chose:** Agent row remains the current-location authority
- **Reasoning:** Agent-node bindings describe available node delivery contracts, but routing only uses an active binding when the agent row still points at that node. This preserves existing transport switch semantics and prevents stale bindings from hijacking deliveries after an agent reconnects directly.

---

## Chapters

### 1. Work
*Agent: default*

- Modeled HTTP push as a node kind with a delivery contract: Modeled HTTP push as a node kind with a delivery contract
- Agent row remains the current-location authority: Agent row remains the current-location authority
