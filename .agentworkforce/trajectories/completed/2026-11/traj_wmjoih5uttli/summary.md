# Trajectory: Address exact-head strict spawn replay findings for Relaycast PR 644

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relaycast#644
> **Confidence:** 92%
> **Started:** November 10, 2026 at 05:25 AM
> **Completed:** November 10, 2026 at 05:40 AM

---

## Summary

Closed four strict spawn replay gaps: capacity-kind fail-closed placement, registration-lag-safe inventory reconciliation, monotonic dispatch-generation fencing, and legacy immutable handler-authority backfill across SQLite/actor/PostgreSQL.

**Approach:** Added one regression per review finding, proved each by reverting its production guard and restoring it byte-for-byte, then ran affected suites, the full engine and root test suites, lint, build, migration generation checks, and diff validation.

---

## Key Decisions

### Fence strict dispatch recovery with a durable monotonic generation
- **Chose:** Fence strict dispatch recovery with a durable monotonic generation
- **Reasoning:** Second-resolution timestamps can collide across restore and redispatch; the generation makes stale terminalization CAS exact.

### Resolve the exact capacity provider before strict spawn placement
- **Chose:** Resolve the exact capacity provider before strict spawn placement
- **Reasoning:** Action-kind capability advertisements must fail closed and must never fall back to the default capacity provider after placement.

### Keep strict spawns in flight across empty inventory snapshots
- **Chose:** Keep strict spawns in flight across empty inventory snapshots
- **Reasoning:** Worker registration may lag dispatch even when verify_ready is false; timeout, provider failure, or node loss remain the authoritative terminal paths.

### Backfill immutable registered-action handler snapshots in both databases
- **Chose:** Backfill immutable registered-action handler snapshots in both databases
- **Reasoning:** Pre-snapshot invocations otherwise reject their original handler after upgrade; migration-time repair preserves the immutable runtime authority boundary.

---

## Chapters

### 1. Work
*Agent: default*

- Fence strict dispatch recovery with a durable monotonic generation: Fence strict dispatch recovery with a durable monotonic generation
- Resolve the exact capacity provider before strict spawn placement: Resolve the exact capacity provider before strict spawn placement
- Keep strict spawns in flight across empty inventory snapshots: Keep strict spawns in flight across empty inventory snapshots
- Backfill immutable registered-action handler snapshots in both databases: Backfill immutable registered-action handler snapshots in both databases
- All four exact-head blockers now have red/green mutation evidence; affected, full engine, root test, lint, build, migration generation, and diff checks pass.

---

## Artifacts

**Commits:** 407366e9
**Files changed:** 21
