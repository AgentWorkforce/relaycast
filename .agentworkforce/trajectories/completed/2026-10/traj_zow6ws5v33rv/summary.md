# Trajectory: Relaycast D1 robustness: index the global stale-online-node scan

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** October 11, 2026 at 12:46 PM
> **Completed:** October 11, 2026 at 01:04 PM

---

## Summary

Added partial covering index idx_nodes_stale_online (status='online', leading last_heartbeat_at) so the global stale-node reconcile sweeps only online rows by heartbeat instead of the full nodes table.

**Approach:** Standard approach

---

## Key Decisions

### Partial covering index over online nodes only
- **Chose:** Partial covering index over online nodes only
- **Reasoning:** reconcileStaleOnlineNodes runs a global (no workspace) status='online' + lapsed-heartbeat scan; every nodes index leads with workspace_id so prod full-scans ~24k rows per tick. Index (last_heartbeat_at, workspace_id, id) WHERE status='online' makes it a covering index scan of the live set only. The OR predicate keeps it a scan-of-index rather than a seek; at partial cardinality that is fine. Numbered 0069 assuming #523's 0068 lands first.

---

## Chapters

### 1. Initial work
*Agent: devin-relaycast-robust*

- Partial covering index over online nodes only: Partial covering index over online nodes only

---

## Artifacts

**Commits:** b9df951a
**Files changed:** 8
