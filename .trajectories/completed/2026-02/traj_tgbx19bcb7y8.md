# Trajectory: Fix agent metadata loss and online flip on dashboard refresh

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 17, 2026 at 09:25 PM
> **Completed:** February 17, 2026 at 09:25 PM

---

## Summary

Updated @relaycast/react usePresence to fetch both agents.list() and agents.presence(), merge full metadata with real-time status, and debounce refresh on presence events. This prevents persona/CLI loss and online reversion after page refresh.

**Approach:** Standard approach

---

## Key Decisions

### usePresence should merge agents.list() metadata with agents.presence() status
- **Chose:** usePresence should merge agents.list() metadata with agents.presence() status
- **Reasoning:** list() has persona/metadata while presence() has accurate online/offline state; using either alone causes either stale status or missing profile data.

### Refresh merged presence data on agent.online/offline events with debounce
- **Chose:** Refresh merged presence data on agent.online/offline events with debounce
- **Reasoning:** WS events can introduce stub agents quickly; debounced refresh backfills full records without hammering API during bursty connect/disconnect.

---

## Chapters

### 1. Work
*Agent: default*

- usePresence should merge agents.list() metadata with agents.presence() status: usePresence should merge agents.list() metadata with agents.presence() status
- Refresh merged presence data on agent.online/offline events with debounce: Refresh merged presence data on agent.online/offline events with debounce
