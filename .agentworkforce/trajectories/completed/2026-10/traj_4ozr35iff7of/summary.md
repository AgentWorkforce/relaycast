# Trajectory: Relaycast D1 robustness: batch agent.register statement groups

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** October 11, 2026 at 12:54 PM
> **Completed:** October 11, 2026 at 01:04 PM

---

## Summary

Batched agent.register via runAtomicWrites (groups [5,2,4]). Review fix: capacity refusal now fails the admission statement (NULL sentinel into nodes.active_agents, decoded as 'node_capacity') so a refused slot aborts the atomic group instead of committing a ghost agent row then compensating.

**Approach:** Standard approach

---

## Key Decisions

### Batch reads+writes in agent.register via the existing BatchCapability port
- **Chose:** Batch reads+writes in agent.register via the existing BatchCapability port
- **Reasoning:** ~11 sequential D1 round-trips per registration under the 5s liveness deadline. Grouped into reads(5)+admission(2)+landing(4): three batch() calls on D1, sequential-in-tx on Node. Compensation tracks applied results in sinks so failed admission releases exactly what landed. Did NOT batch reserve+insert+landing into one group because an onConflictDoNothing insert would still let the binding insert FK-fail the whole batch, losing the clean agent_already_exists 409.

---

## Chapters

### 1. Initial work
*Agent: devin-relaycast-robust*

- Batch reads+writes in agent.register via the existing BatchCapability port: Batch reads+writes in agent.register via the existing BatchCapability port

---

## Artifacts

**Commits:** 012e5f38
**Files changed:** 7
