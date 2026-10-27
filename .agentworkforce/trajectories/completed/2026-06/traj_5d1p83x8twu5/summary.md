# Trajectory: Implement node kind role delivery adapter split

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 25, 2026 at 05:57 AM
> **Completed:** June 25, 2026 at 06:20 AM

---

## Summary

Opened PR #214 splitting node transport kind from ownership role and unifying direct/broker WebSocket delivery on ws.node.v1, with docs, OpenAPI, SDKs, migration, and conformance coverage.

**Approach:** Standard approach

---

## Key Decisions

### Split node kind from role and unify WebSocket adapter
- **Chose:** Split node kind from role and unify WebSocket adapter
- **Reasoning:** Using kind for both transport and ownership kept direct and broker WebSocket delivery on separate paths. The new model uses kind=ws/http_push/poll, role=direct/broker, and delivery_adapter=ws.node.v1 for all WebSocket durable delivery frames.

---

## Chapters

### 1. Work
*Agent: default*

- Split node kind from role and unify WebSocket adapter: Split node kind from role and unify WebSocket adapter

---

## Artifacts

**Commits:** 195358d, 70207ba, 639de68, 4d59f19, 8f24574
**Files changed:** 41
