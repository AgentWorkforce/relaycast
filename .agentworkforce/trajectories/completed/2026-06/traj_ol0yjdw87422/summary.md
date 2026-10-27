# Trajectory: Unify agent delivery around nodes

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 24, 2026 at 10:36 PM
> **Completed:** June 24, 2026 at 11:15 PM

---

## Summary

Unified agent delivery around first-class nodes: direct websocket agents now get implicit direct_ws nodes, fleet/http routes are always-on, workspace/fleet rollout toggles were removed, channel/message fanout is binding-aware, and SDK/docs surfaces were updated for the clean break.

**Approach:** Standard approach

---

## Key Decisions

### Made node routing unconditional and treated direct websocket agents as implicit direct_ws nodes
- **Chose:** Made node routing unconditional and treated direct websocket agents as implicit direct_ws nodes
- **Reasoning:** The clean-break invariant is one active node binding and one delivery route per agent; workspace streams are observer-only and route fanout must be binding-aware.

---

## Chapters

### 1. Work
*Agent: default*

- Made node routing unconditional and treated direct websocket agents as implicit direct_ws nodes: Made node routing unconditional and treated direct websocket agents as implicit direct_ws nodes
