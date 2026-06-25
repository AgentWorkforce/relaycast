# Trajectory: Make realtime delivery node-only

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 25, 2026 at 06:52 AM
> **Completed:** June 25, 2026 at 07:56 AM

---

## Summary

Implemented node-only realtime delivery: workspace streams are observer-only, agents mint node tokens and receive realtime over direct or broker nodes, spawn/release use node action.invoke, handler-agent actions dispatch through bound nodes, node deliver frames cover action lifecycle/reactions/receipts, and TypeScript/Rust/Swift/Python SDK docs/tests were updated. Verified JS build/test/lint, Rust cargo tests, and Swift tests; Python pytest is unavailable in this environment.

**Approach:** Standard approach

---

## Key Decisions

### Made node transport the only agent realtime path
- **Chose:** Made node transport the only agent realtime path
- **Reasoning:** Agent tokens are REST identity; all realtime delivery now routes through node bindings, direct node-of-one for self-registered agents, and workspace WebSocket remains observer-only.

### Dispatched agent-owned actions through bound nodes
- **Chose:** Dispatched agent-owned actions through bound nodes
- **Reasoning:** Removing direct sockets meant handler_agent invocations and action completion/denial notifications had to use node action.invoke and node deliver frames, while SDKs preserve actionInvoked callbacks.

### Updated Rust Swift Python and TypeScript SDK surfaces with node transport contracts
- **Chose:** Updated Rust Swift Python and TypeScript SDK surfaces with node transport contracts
- **Reasoning:** The major upgrade changes authentication and WebSocket behavior across all supported SDKs, so agent connect flows mint node tokens and node frames are normalized into existing callbacks where appropriate.

---

## Chapters

### 1. Work
*Agent: default*

- Made node transport the only agent realtime path: Made node transport the only agent realtime path
- Dispatched agent-owned actions through bound nodes: Dispatched agent-owned actions through bound nodes
- Updated Rust Swift Python and TypeScript SDK surfaces with node transport contracts: Updated Rust Swift Python and TypeScript SDK surfaces with node transport contracts
