# Trajectory: Drain workspace delivery capacity when agents are released

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** September 20, 2026 at 09:53 AM
> **Completed:** September 20, 2026 at 10:00 AM

---

## Summary

Dead-lettered active delivery rows during irreversible agent release across direct, local, guarded node, and legacy node lifecycle paths; added release-path and expired-unswept workspace-cap regressions; full engine suite, typecheck, and lint pass.

**Approach:** Standard approach

---

## Key Decisions

### Fix capacity recovery in the Relaycast engine release lifecycle
- **Chose:** Fix capacity recovery in the Relaycast engine release lifecycle
- **Reasoning:** Release stops future fan-out but queued/delivered rows for the tombstoned recipient remain active and continue consuming the workspace cap until TTL. The engine owns both the lifecycle mutation and active-depth accounting, so it can atomically dead-letter those rows on irreversible delete_agent releases across every path.

---

## Chapters

### 1. Work
*Agent: default*

- Fix capacity recovery in the Relaycast engine release lifecycle: Fix capacity recovery in the Relaycast engine release lifecycle
- Release-time settlement now covers direct deletion, local reaping, guarded node completion, and legacy node completion. Full engine suite passed (1,154 tests), and a workspace-cap regression proves expired unswept rows are already excluded from admission.
