# Trajectory: Fix #258: key node enrollment on node_id, not name

> **Status:** ✅ Completed
> **Task:** relaycast#258
> **Confidence:** 90%
> **Started:** July 16, 2026 at 04:07 AM
> **Completed:** July 16, 2026 at 04:08 AM

---

## Summary

POST /v1/nodes now keys on node_id when supplied: same id rotates/renames in place, new id creates a node, and a cross-id name collision is an explicit 409 node_name_conflict (matching node.register) instead of silently rewriting the other node. Name-only enrollment still rotates by name. Added 5 conformance tests; updated openapi + changelogs.

**Approach:** Standard approach

---

## Key Decisions

### Enrollment keys on node_id when supplied; name lookup only as fallback for callers without a stable id
- **Chose:** Enrollment keys on node_id when supplied; name lookup only as fallback for callers without a stable id
- **Reasoning:** node_id is the stable identity; keying on name let a second enroll silently rewrite a different node. Name-keyed rotate preserved for backwards compat (existing conformance test relies on it). Cross-id name collision is now an explicit 409 node_name_conflict, matching node.register — no takeover flag until a real need appears (user-confirmed).

---

## Chapters

### 1. Work
*Agent: default*

- Enrollment keys on node_id when supplied; name lookup only as fallback for callers without a stable id: Enrollment keys on node_id when supplied; name lookup only as fallback for callers without a stable id
