# Trajectory: Expand server telemetry coverage across routes and align schema/docs/tests

> **Status:** ✅ Completed
> **Confidence:** 88%
> **Started:** February 19, 2026 at 08:35 PM
> **Completed:** February 19, 2026 at 08:42 PM

---

## Summary

Added server-side telemetry coverage for core E2E mutations, introduced shared route telemetry emitter helper, expanded telemetry schema required props, and updated TELEMETRY.md event catalog + distinct_id guidance. Validated with types/server builds and full server/types tests.

**Approach:** Standard approach

---

## Key Decisions

### Expanded server telemetry from narrow lifecycle events to broad API mutation coverage
- **Chose:** Expanded server telemetry from narrow lifecycle events to broad API mutation coverage
- **Reasoning:** E2E exercises many mutating features beyond message/file/reaction/search/ws, so we added first-class server events for workspace/agent/channel/dm/commands/webhooks/presence/system prompt to close product-usage blind spots while keeping workspace-based distinct_id.

---

## Chapters

### 1. Work
*Agent: default*

- Expanded server telemetry from narrow lifecycle events to broad API mutation coverage: Expanded server telemetry from narrow lifecycle events to broad API mutation coverage
