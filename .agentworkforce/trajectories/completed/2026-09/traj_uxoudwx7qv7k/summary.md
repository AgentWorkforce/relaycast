# Trajectory: Close second-round Relaycast workspace idempotency review findings

> **Status:** ✅ Completed
> **Task:** relaycast#372
> **Confidence:** 95%
> **Started:** September 5, 2026 at 10:31 PM
> **Completed:** September 5, 2026 at 10:31 PM

---

## Summary

Canonicalized workspace-create request hashing, removed a redundant index, aligned release notes, corrected auth documentation, and added regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Hash declared provenance in a fixed schema order
- **Chose:** Hash declared provenance in a fixed schema order
- **Reasoning:** JSON object insertion order is not semantic; idempotency digests must treat equivalent request bodies as the same request.

### Remove the duplicate workspace binding index
- **Chose:** Remove the duplicate workspace binding index
- **Reasoning:** The unique workspace_id index already supports equality lookup and avoids duplicate write amplification.

---

## Chapters

### 1. Work
*Agent: default*

- Hash declared provenance in a fixed schema order: Hash declared provenance in a fixed schema order
- Remove the duplicate workspace binding index: Remove the duplicate workspace binding index
