# Trajectory: Add durable workspace event log (observer plane v1): 0027 migration, append+stamp+publish on workspace stream, GET /v1/workspace/events, 30-day retention

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** July 2, 2026 at 04:15 AM
> **Completed:** July 2, 2026 at 04:16 AM

---

## Summary

Added durable workspace event log: 0027 workspace_events migration + drizzle schema, engine/workspaceEvents.ts (appendWorkspaceEvent/listWorkspaceEvents/appendAndPublishWorkspaceEvent), all fanout+deliveryRouting stream call sites now append+stamp seq, GET /v1/workspace/events (workspace key or stream:read observer with channel scoping), 30-day retention in pruneExpired, tests + E2E verified

**Approach:** Standard approach

---

## Key Decisions

### Kept observer filtering on the events route to channel_id scoping (observerAllowsChannel with channel-name lookup); null channel_id rows pass
- **Chose:** Kept observer filtering on the events route to channel_id scoping (observerAllowsChannel with channel-name lookup); null channel_id rows pass
- **Reasoning:** Matches the contract exactly; deeper payload-level filtering (observerAllowsEvent) would change visibility semantics for DM/agent filters beyond the v1 contract

---

## Chapters

### 1. Work
*Agent: default*

- Kept observer filtering on the events route to channel_id scoping (observerAllowsChannel with channel-name lookup); null channel_id rows pass: Kept observer filtering on the events route to channel_id scoping (observerAllowsChannel with channel-name lookup); null channel_id rows pass
- Retention added as workspaceEventTtlDays (default 30d) in pruneExpired with per-workspace workspace_event_ttl_days override; batched deletes via rowid due to composite PK: Retention added as workspaceEventTtlDays (default 30d) in pruneExpired with per-workspace workspace_event_ttl_days override; batched deletes via rowid due to composite PK
