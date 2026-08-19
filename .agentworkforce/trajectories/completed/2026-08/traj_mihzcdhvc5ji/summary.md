# Trajectory: Add Relaycast workspace usage attribution contract

> **Status:** ✅ Completed
> **Task:** relaycast#337
> **Confidence:** 65%
> **Started:** August 18, 2026 at 12:05 PM
> **Completed:** August 18, 2026 at 12:16 PM

---

## Summary

Implemented portable workspace creation provenance, explicit usage classification, and first-party CI population. Hosted aggregation belongs to a companion relaycast-cloud change and was not verified by this trajectory.

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

### Place attribution migration 0039 after workspace lifecycle and session-replay migrations
- **Chose:** Place attribution migration 0039 after workspace lifecycle and session-replay migrations
- **Reasoning:** Current main owns migrations 0036 through 0038; attribution must use 0039 to preserve production migration ordering.

### Ship the portable creator contract here; track hosted and cross-repo work separately
- **Chose:** Ship the portable creator contract here; track hosted and cross-repo work separately
- **Reasoning:** Relaycast owns the portable API/SDK/MCP contract. Hosted aggregation and other repositories need their own evidence and context-specific decisions.

---

## Chapters

### 1. Work
*Agent: default*

- Store provenance and classification in the existing workspace insert: Store provenance and classification in the existing workspace insert
- Keep historical rows unknown and expose legacy name matches only as low-confidence inference: Keep historical rows unknown and expose legacy name matches only as low-confidence inference
- Host the usage view in relaycast-cloud behind the existing internal bearer: Host the usage view in relaycast-cloud behind the existing internal bearer
- Default usage rankings to external classification: Default usage rankings to external classification
- Place attribution migration 0039 after workspace lifecycle and session-replay migrations: Place attribution migration 0039 after workspace lifecycle and session-replay migrations
- Ship the portable creator contract here; track hosted and cross-repo work separately: Ship the portable creator contract here; track hosted and cross-repo work separately
- This trajectory records implementation of the portable creation-attribution contract and first-party E2E population. It contains no run, test, or proof events, so it does not establish verification. The hosted usage view belongs to a companion relaycast-cloud change and was not exercised here.

---

## Artifacts

**Commits:** 9cb6d5180966deafa4b268fbfbd4696f8a66d528
**Files changed:** 32
