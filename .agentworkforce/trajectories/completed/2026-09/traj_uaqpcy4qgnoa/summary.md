# Trajectory: Reproduce and fix node-wide inventory presence starvation

> **Status:** ✅ Completed
> **Task:** delivery-repro-0902
> **Confidence:** 94%
> **Started:** September 2, 2026 at 11:17 AM
> **Completed:** September 2, 2026 at 11:45 AM

---

## Summary

Reproduced node-wide delivery starvation with an expected-red RelayFlow and fixed Relaycast inventory reconciliation to isolate conflicting members without weakening all-untrusted rejection.

**Approach:** Standard approach

---

## Key Decisions

### Treat inventory conflicts as item-scoped when a batch contains valid siblings
- **Chose:** Treat inventory conflicts as item-scoped when a batch contains valid siblings
- **Reasoning:** Production A/B shows one advertised-but-unbound chief entry while 21 matching siblings expired together; the control passes and the poisoned three-item inventory reproduces agent_location_conflict aborting the entire node batch. Bad identity/location claims remain fail-closed, but must not starve unrelated valid agents.

### Fix inventory reconciliation at the Relaycast batch boundary by isolating invalid members while preserving fail-closed all-untrusted batches
- **Chose:** Fix inventory reconciliation at the Relaycast batch boundary by isolating invalid members while preserving fail-closed all-untrusted batches
- **Reasoning:** The broker sends an authoritative node snapshot, so client-side splitting would mark omitted healthy siblings offline. Relaycast owns the atomic rejection and can safely renew the valid subset while rejecting stale provider, location, or ID claims.

---

## Chapters

### 1. Work
*Agent: default*

- Treat inventory conflicts as item-scoped when a batch contains valid siblings: Treat inventory conflicts as item-scoped when a batch contains valid siblings
- Must-not-fire control is green and poisoned-node arm is red with agent_location_conflict before any valid sibling renewal
- Fix inventory reconciliation at the Relaycast batch boundary by isolating invalid members while preserving fail-closed all-untrusted batches: Fix inventory reconciliation at the Relaycast batch boundary by isolating invalid members while preserving fail-closed all-untrusted batches
- The exact base/head RelayFlow now proves the production-shaped cursor-aware failure: one conflicting member blocks readiness for two valid siblings, whose authenticated reads become offline with pending deliveries; the head isolates the poison and drains both.

---

## Evidence record (completed-work audit trail)

- **Product commit:** `3cad6e343acf69adb76b5d73cc8d3aae9cf23d0a` (`fix(engine): isolate conflicting inventory members`), based on `dd477eba` (main at branch time).
- **Follow-up repair commits:** `c26ef054` (`fix(engine): keep rejected-but-present inventory members online` — review P1) and the same-series commit adding the proof-runner try-scope cleanup (review P3).
- **Complete changed-file list (product commit):** `CHANGELOG.md`, `packages/engine/CHANGELOG.md`, `packages/engine/src/engine/node.ts`, `packages/engine/src/__tests__/conformance/inventoryPresenceIsolation.test.ts`, `tests/relayflows/cases/0902-node-inventory-presence-isolation/{case.json,run.mjs,probe.test.ts}`, `.agentworkforce/trajectories/completed/2026-09/traj_uaqpcy4qgnoa/{summary.md,trajectory.json}`.
- **Evidence:** red on base `dd477eba` (agent_location_conflict aborts the whole batch, siblings offline with pending deliveries), green on head; engine suite 70 files / 704 tests; `tsc` clean.
