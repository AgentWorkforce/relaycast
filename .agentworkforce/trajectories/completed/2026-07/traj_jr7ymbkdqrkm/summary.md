# Trajectory: Engine: multi-provider nodes and node-scoped actions (node-providers spec step 1)

> **Status:** ✅ Completed
> **Task:** node-providers
> **Confidence:** 80%
> **Started:** July 8, 2026 at 06:43 AM
> **Completed:** July 8, 2026 at 07:26 AM

---

## Summary

Engine multi-provider nodes: fleet-wire provider fields, node_providers table, node-scoped actions + node-addressed invoke, spawn shadowing, per-provider liveness/deliver routing, synthetic default provider

**Approach:** Standard approach

---

## Key Decisions

### Kept nodes aggregate columns + per-provider node_providers table; default-provider actions stay workspace-global aliases (first-writer-wins) for additive migration
- **Chose:** Kept nodes aggregate columns + per-provider node_providers table; default-provider actions stay workspace-global aliases (first-writer-wins) for additive migration
- **Reasoning:** Preserves current broker behavior while adding provider persistence, routing, and node-scoped actions

---

## Chapters

### 1. Work
*Agent: default*

- Kept nodes aggregate columns + per-provider node_providers table; default-provider actions stay workspace-global aliases (first-writer-wins) for additive migration: Kept nodes aggregate columns + per-provider node_providers table; default-provider actions stay workspace-global aliases (first-writer-wins) for additive migration
