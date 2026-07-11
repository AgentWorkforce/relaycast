# Trajectory: Harden cursor delivery readiness and provider inventory isolation

> **Status:** ✅ Completed
> **Task:** relaycast#254-review
> **Confidence:** 95%
> **Started:** July 11, 2026 at 08:43 AM
> **Completed:** July 11, 2026 at 09:09 AM

---

## Summary

Hardened cursor-aware broker recovery with connection-scoped delivery readiness, provider-scoped inventory reconciliation, canonical agent validation, provider-persistent invocation dispatch and migration inference, and provider authorization for results and acknowledgements. Added cross-provider, live/seq-zero gate, compatibility, identity, and migration regression coverage; focused 108 tests and full 437 engine tests pass with typecheck, lint, and build.

**Approach:** Standard approach

---

## Key Decisions

### Track delivery readiness on each active provider connection
- **Chose:** Track delivery readiness on each active provider connection
- **Reasoning:** Query-time replay scoping does not stop concurrent live fanout. The registry must gate positive-sequence deliver frames until the cursor reply is sent, with an immediate mode for legacy providers and an identity set for negotiated providers.

### Persist the invocation's dispatched provider
- **Chose:** Persist the invocation's dispatched provider
- **Reasoning:** Provider-scoped inventory cannot safely reschedule node invocations from node_id alone. Recording the dispatch provider makes inventory reconciliation exact for action, capacity, and agent-hosted invocations.

### Backfill dispatched providers from node actions or their handler agents
- **Chose:** Backfill dispatched providers from node actions or their handler agents
- **Reasoning:** Inventory reconciliation is provider-scoped, so defaulting an agent-hosted named-provider invocation would let the wrong provider reconcile it; native legacy dispatches retain the synthetic default fallback.

### Authorize node control mutations by provider as well as node
- **Chose:** Authorize node control mutations by provider as well as node
- **Reasoning:** A multi-provider node shares a node credential and transport surface, so node ID alone cannot authorize action results or cumulative delivery acknowledgements; the bound provider must own the invocation or agent.

### Leave historically ambiguous multi-provider invocations unclaimed
- **Chose:** Leave historically ambiguous multi-provider invocations unclaimed
- **Reasoning:** When migration evidence cannot identify a unique provider, NULL prevents the wrong provider inventory from completing or rescheduling the invocation; the global timeout sweep remains the conservative recovery path.

---

## Chapters

### 1. Work
*Agent: default*

- Track delivery readiness on each active provider connection: Track delivery readiness on each active provider connection
- Persist the invocation's dispatched provider: Persist the invocation's dispatched provider
- Backfill dispatched providers from node actions or their handler agents: Backfill dispatched providers from node actions or their handler agents
- Review fixes now cover connection-scoped readiness for durable and ephemeral delivery, provider-owned inventory reconciliation, canonical agent identity validation, and provider-persistent invocation dispatch. Focused conformance, migration, atomicity, typecheck, lint, build, and the full 436-test engine suite are green before the final review pass.
- Authorize node control mutations by provider as well as node: Authorize node control mutations by provider as well as node
- Leave historically ambiguous multi-provider invocations unclaimed: Leave historically ambiguous multi-provider invocations unclaimed
