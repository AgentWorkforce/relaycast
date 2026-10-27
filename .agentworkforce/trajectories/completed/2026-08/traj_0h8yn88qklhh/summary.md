# Trajectory: Persist and expose unmeasured fleet node load

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** August 6, 2026 at 11:57 AM
> **Completed:** August 6, 2026 at 11:59 AM

---

## Summary

Made fleet load explicitly unreported for unbounded or partially measured nodes, preserved finite [0,1] utilization, corrected max_agents=0 aggregate semantics, and updated official SDKs plus migration/tests.

**Approach:** Standard approach

---

## Key Decisions

### Define load as bounded managed-agent capacity utilization; max_agents=0 remains unlimited and therefore has no load denominator
- **Chose:** Define load as bounded managed-agent capacity utilization; max_agents=0 remains unlimited and therefore has no load denominator
- **Reasoning:** The broker and Relaycast admission already define 0 as unlimited. CPU, memory, and queue pressure are different metrics; substituting idle for an undefined denominator is the observed defect.

---

## Chapters

### 1. Work
*Agent: default*

- Define load as bounded managed-agent capacity utilization; max_agents=0 remains unlimited and therefore has no load denominator: Define load as bounded managed-agent capacity utilization; max_agents=0 remains unlimited and therefore has no load denominator
