# Trajectory: Route client telemetry through server ingestion endpoint instead of direct PostHog calls

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** February 19, 2026 at 05:54 PM
> **Completed:** February 19, 2026 at 06:10 PM

---

## Summary

Implemented server-side telemetry ingestion and lifecycle capture, added shared telemetry schema/validation in @relaycast/types, routed CLI+MCP telemetry through /v1/telemetry/events with required origin attribution, and added data-quality tests plus golden KPI dashboard specs.

**Approach:** Standard approach

---

## Key Decisions

### Implement telemetry ingestion via server endpoint and enforce origin in shared internal schema
- **Chose:** Implement telemetry ingestion via server endpoint and enforce origin in shared internal schema
- **Reasoning:** Keeps client keys out of CLIs/MCP, centralizes governance, and guarantees consistent origin attribution for all analytics events.

### Implement shared telemetry schema inside @relaycast/types instead of creating a new workspace package
- **Chose:** Implement shared telemetry schema inside @relaycast/types instead of creating a new workspace package
- **Reasoning:** Avoids workspace install churn while still providing one package consumed by CLI, MCP, and server emitters.

---

## Chapters

### 1. Work
*Agent: default*

- Implement telemetry ingestion via server endpoint and enforce origin in shared internal schema: Implement telemetry ingestion via server endpoint and enforce origin in shared internal schema
- Implement shared telemetry schema inside @relaycast/types instead of creating a new workspace package: Implement shared telemetry schema inside @relaycast/types instead of creating a new workspace package
