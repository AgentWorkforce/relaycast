# Trajectory: Engine retention pruning + outbox follow-ups

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 11, 2026 at 01:18 PM
> **Completed:** June 11, 2026 at 01:27 PM

---

## Summary

Engine retention pruning (pruneExpired, workspaces.retention column, Node cleanup-tick wiring, public export), exhausted pending_events settling in cleanupOldEvents, and zero-subscriber outbox skip with per-request memoization. Full engine suite + repo turbo build/lint/test green.

**Approach:** Standard approach

---

## Key Decisions

### Retention config lives in a nullable workspaces.retention JSON column, not the entitlements port
- **Chose:** Retention config lives in a nullable workspaces.retention JSON column, not the entitlements port
- **Reasoning:** Pruning runs out-of-request (Node cleanup tick / cloud cron) where no entitlements provider or Workspace object exists; a DB column lets pruneExpired resolve per-workspace TTLs itself in one query, with no port signature changes. Entitlements stays the billing/quota seam.

### Deliveries and message_logs default to 90-day TTL; messages retention strictly opt-in
- **Chose:** Deliveries and message_logs default to 90-day TTL; messages retention strictly opt-in
- **Reasoning:** Settled deliveries and message_logs are operational telemetry (message_logs duplicates bodies already retained in messages); messages are user data so no surprise deletion. Explicit null in workspace settings disables even the operational defaults.

---

## Chapters

### 1. Work
*Agent: default*

- Retention config lives in a nullable workspaces.retention JSON column, not the entitlements port: Retention config lives in a nullable workspaces.retention JSON column, not the entitlements port
- Deliveries and message_logs default to 90-day TTL; messages retention strictly opt-in: Deliveries and message_logs default to 90-day TTL; messages retention strictly opt-in
