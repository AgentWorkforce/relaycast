# Trajectory: Remove telemetry ingestion endpoint and send client telemetry directly to PostHog

> **Status:** ❌ Abandoned
> **Started:** February 19, 2026 at 07:34 PM
> **Completed:** February 20, 2026 at 01:32 PM

---

## Key Decisions

### Kept shared telemetry schema validation in client emitters
- **Chose:** Kept shared telemetry schema validation in client emitters
- **Reasoning:** Direct transport changed, but event shape, property sanitization, and event-name constraints still need to stay consistent.

---

## Chapters

### 1. Work
*Agent: default*

- Kept shared telemetry schema validation in client emitters: Kept shared telemetry schema validation in client emitters
- Abandoned: Switching to a new cleanup task requested by user
