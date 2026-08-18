# Trajectory: Add indexed session_ref replay lookup and effective retention boundary

> **Status:** ✅ Completed
> **Task:** relay#1522
> **Confidence:** 93%
> **Started:** August 18, 2026 at 11:01 PM
> **Completed:** August 18, 2026 at 11:39 PM

---

## Summary

Added bounded indexed session_ref replay lookup, payload-free aged-out evidence, live per-workspace retention boundaries, fail-closed SDK resolution, and metadata preservation across send and redelivery paths.

**Approach:** Standard approach

---

## Key Decisions

### Use an indexed message column plus a payload-free session ledger
- **Chose:** Use an indexed message column plus a payload-free session ledger
- **Reasoning:** An index over retained messages makes lookup bounded, while the ledger survives payload pruning so aged-out sessions remain distinguishable from unknown or never-observed references.

### Return partial and unknown as explicit non-replayable states
- **Chose:** Return partial and unknown as explicit non-replayable states
- **Reasoning:** A session can cross a live retention boundary, and missing boundary/query evidence cannot safely imply full replay coverage.

---

## Chapters

### 1. Work
*Agent: default*

- Use an indexed message column plus a payload-free session ledger: Use an indexed message column plus a payload-free session ledger
- Return partial and unknown as explicit non-replayable states: Return partial and unknown as explicit non-replayable states
- Indexed lookup and durable aged-out evidence are integrated across message writers; full engine and MCP suites exposed and closed group-DM reconnect metadata parity plus workspace ownership coverage.
