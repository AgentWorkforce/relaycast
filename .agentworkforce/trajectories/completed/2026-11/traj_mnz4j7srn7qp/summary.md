# Trajectory: Add exact-node durable spawn replay for Relay Flows callers

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** November 8, 2026 at 05:11 PM
> **Completed:** November 8, 2026 at 05:49 PM

---

## Summary

Added a mixed-version-safe strict builtin spawn route and replay-only recovery contract. Exact node identity, caller scope, logical request, durable idempotency, server-owned proof, registered-action bypass, and legacy compatibility are pinned by full gates, targeted mutations, and independent review. Paired Relay client integration is required before release.

**Approach:** Standard approach

---

## Key Decisions

### Use server-owned strict logical spawn claims plus a replay-only recovery route
- **Chose:** Use server-owned strict logical spawn claims plus a replay-only recovery route
- **Reasoning:** A bounded local receipt ledger can permanently strand accepted spawns; Relaycast already owns the durable idempotency claim. The strict envelope binds exact node identity while allowing only local worker_cwd rematerialization, and replay-only cannot create, place, or dispatch.

### Preserve legacy action payloads unless spawn_contract explicitly opts into relay.spawn.invoke.logical/1
- **Chose:** Preserve legacy action payloads unless spawn_contract explicitly opts into relay.spawn.invoke.logical/1
- **Reasoning:** Existing callers may already use target_node_id or logical_request as application metadata; exact legacy retries must remain byte-compatible.

### Require a server-owned applied marker on strict spawn acknowledgments
- **Chose:** Require a server-owned applied marker on strict spawn acknowledgments
- **Reasoning:** An older Relaycast can accept the versioned fields as inert metadata and still place by name. Persisting the marker in the durable claim and returning it in invoke/replay responses gives relay-node a fail-closed rolling-upgrade proof; client-supplied markers and pre-proof rows are rejected.

---

## Chapters

### 1. Work
*Agent: default*

- Use server-owned strict logical spawn claims plus a replay-only recovery route: Use server-owned strict logical spawn claims plus a replay-only recovery route
- Preserve legacy action payloads unless spawn_contract explicitly opts into relay.spawn.invoke.logical/1: Preserve legacy action payloads unless spawn_contract explicitly opts into relay.spawn.invoke.logical/1
- Relaycast and Relay client tests pass, and mutation checks caught both name-reuse retry redirection and unsafe-directory recovery regressions. Desktop still needs its durable pre-spawn intent/worker mapping before real direct-node E2E can close.
- Require a server-owned applied marker on strict spawn acknowledgments: Require a server-owned applied marker on strict spawn acknowledgments
- The strict spawn contract is now split onto a dedicated pre-side-effect route, server-owned proof is tied to builtin provenance, external retries recover from durable Relaycast claims, and legacy session request bytes remain unchanged. Full engine and client gates plus three targeted mutation checks pass; independent final re-review is pending before draft PR publication.
