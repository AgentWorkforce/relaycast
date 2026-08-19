# Trajectory: Persist safe Relaycast fleet repo keys

> **Status:** ✅ Completed
> **Task:** factory placement lane 2
> **Confidence:** 92%
> **Started:** August 19, 2026 at 09:21 AM
> **Completed:** August 19, 2026 at 09:21 AM

---

## Summary

Added validated repo_keys, canonical repo tags, reconnect/readback coverage, and release documentation in PR #343.

**Approach:** Standard approach

---

## Key Decisions

### Reused nodes.tags for placement keys
- **Chose:** Reused nodes.tags for placement keys
- **Reasoning:** Relay SDK already derives repo keys from repo:<owner>/<repo> tags, avoiding a schema migration while keeping absolute paths out of Relaycast.

---

## Chapters

### 1. Work
*Agent: default*

- Reused nodes.tags for placement keys: Reused nodes.tags for placement keys
