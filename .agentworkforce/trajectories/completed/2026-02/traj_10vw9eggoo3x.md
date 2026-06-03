# Trajectory: Implement workspace-key websocket stream and remove dashboard polling

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 18, 2026 at 06:47 PM
> **Completed:** February 18, 2026 at 06:55 PM

---

## Summary

Implemented workspace-key websocket stream (rk_live) via WorkspaceStreamDO, published fanout + presence events to it, switched dashboard WS to workspace key, removed observer-join dependency and polling loops, and removed observer invite step from e2e.

**Approach:** Standard approach

---

## Key Decisions

### Introduce workspace-key websocket stream and publish all fanout events to it
- **Chose:** Introduce workspace-key websocket stream and publish all fanout events to it
- **Reasoning:** Observer dashboards need workspace-wide realtime visibility without synthetic channel membership. A dedicated workspace stream authenticated by rk_live keys decouples observability from agent joins and makes websocket behavior deterministic.

### Remove dashboard polling loops in favor of websocket-driven updates
- **Chose:** Remove dashboard polling loops in favor of websocket-driven updates
- **Reasoning:** Polling masked realtime delivery issues and added lag/complexity. With workspace websocket stream available, activity and DM updates can be driven directly by pushed events with only an initial snapshot fetch.

---

## Chapters

### 1. Work
*Agent: default*

- Introduce workspace-key websocket stream and publish all fanout events to it: Introduce workspace-key websocket stream and publish all fanout events to it
- Remove dashboard polling loops in favor of websocket-driven updates: Remove dashboard polling loops in favor of websocket-driven updates
