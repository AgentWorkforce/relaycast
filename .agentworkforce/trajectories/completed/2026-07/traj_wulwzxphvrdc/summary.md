# Trajectory: Emit durable agent.exited and node.status events (issue #273)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** July 16, 2026 at 04:15 AM
> **Completed:** July 16, 2026 at 04:34 AM

---

## Summary

Emitted durable agent.exited (deregister / inventory-missing / release) and node.status.online/offline events through the invocation-completion fanout (workspace event log, webhook outbox, spawn caller mailbox); threaded optional completion deps through node/action transition sites

**Approach:** Standard approach

---

## Artifacts

**Commits:** 625a610
**Files changed:** 19
