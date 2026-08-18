# Trajectory: Add Relaycast workspace usage attribution and hosted usage reporting

> **Status:** ✅ Completed
> **Task:** relaycast#337
> **Confidence:** 90%
> **Started:** August 18, 2026 at 12:05 PM
> **Completed:** August 18, 2026 at 12:16 PM

---

## Summary

Added workspace creation provenance, explicit usage classification, first-party CI population, and a hosted internal per-workspace usage view with honest legacy handling and no message-path writes.

**Approach:** Standard approach

---

## Key Decisions

### Store provenance and classification in the existing workspace insert
- **Chose:** Store provenance and classification in the existing workspace insert
- **Reasoning:** Captures creator context without an extra creation write or any per-message write.

### Keep historical rows unknown and expose legacy name matches only as low-confidence inference
- **Chose:** Keep historical rows unknown and expose legacy name matches only as low-confidence inference
- **Reasoning:** The 41,320 existing rows cannot be attributed reliably; heuristics must not become facts.

### Host the usage view in relaycast-cloud behind the existing internal bearer
- **Chose:** Host the usage view in relaycast-cloud behind the existing internal bearer
- **Reasoning:** The portable engine owns the creation contract; the hosted gateway owns operator-only cross-workspace aggregation and classification.

### Default usage rankings to external classification
- **Chose:** Default usage rankings to external classification
- **Reasoning:** An implicit all-workspace view would be dominated by internal and unknown fleet traffic and actively mislead operators.

### Stack attribution migration 0037 after workspace lifecycle migration 0036
- **Chose:** Stack attribution migration 0037 after workspace lifecycle migration 0036
- **Reasoning:** Lifecycle PR #338 claimed 0036 first; preserving filename order prevents a D1 migration collision and keeps the hosted copies byte-identical.

### Ship creator contract and hosted view now; track broker and relayflow population separately
- **Chose:** Ship creator contract and hosted view now; track broker and relayflow population separately
- **Reasoning:** Relaycast owns the API/SDK/MCP contract and first-party E2E population. Relay and Cloud need context-specific internal/external decisions, tracked in relay#1569 and cloud#3076 rather than hard-coded guesses.

---

## Chapters

### 1. Work
*Agent: default*

- Store provenance and classification in the existing workspace insert: Store provenance and classification in the existing workspace insert
- Keep historical rows unknown and expose legacy name matches only as low-confidence inference: Keep historical rows unknown and expose legacy name matches only as low-confidence inference
- Host the usage view in relaycast-cloud behind the existing internal bearer: Host the usage view in relaycast-cloud behind the existing internal bearer
- Default usage rankings to external classification: Default usage rankings to external classification
- Stack attribution migration 0037 after workspace lifecycle migration 0036: Stack attribution migration 0037 after workspace lifecycle migration 0036
- Ship creator contract and hosted view now; track broker and relayflow population separately: Ship creator contract and hosted view now; track broker and relayflow population separately
- Portable creation attribution, first-party E2E population, hosted usage aggregation, and operator classification are verified. Historical rows remain unknown; cross-repo high-volume creator coverage is explicitly tracked.

---

## Artifacts

**Commits:** db5fac7, c1bb456
**Files changed:** 37
