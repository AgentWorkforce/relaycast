# Trajectory: Relaycast D1 robustness: fix hot registration/liveness queries

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** October 11, 2026 at 12:30 PM
> **Completed:** October 11, 2026 at 12:59 PM

---

## Summary

Indexed the cancelled-spawn tombstone check on agent.register: non-partial composite (workspace_id, dispatched_node_id) on action_invocations — the partial-index form could not be proven under bound parameters (0065 lesson, flagged in review). ~216k rows/1.8s per registration becomes a ~10-row equality seek; also serves the spawn-reservation EXISTS.

**Approach:** Standard approach

---

## Key Decisions

### Partial index on action_invocations for the cancelled-spawn tombstone check
- **Chose:** Partial index on action_invocations for the cancelled-spawn tombstone check
- **Reasoning:** agent.register scans the whole status='failed' bucket (~216k rows, ~1.8s on prod D1) looking for tombstones that all carry error='invocation_origin_unavailable' (~2.9k rows). A partial index on (workspace_id, dispatched_node_id) WHERE status='failed' AND error='invocation_origin_unavailable' lets SQLite seek only matchable rows; predicates imply the partial WHERE clause so no INDEXED BY hint is needed.

---

## Chapters

### 1. Initial work
*Agent: devin-relaycast-robust*

- Partial index on action_invocations for the cancelled-spawn tombstone check: Partial index on action_invocations for the cancelled-spawn tombstone check

---

## Artifacts

**Commits:** f3ac4f18
**Files changed:** 8
