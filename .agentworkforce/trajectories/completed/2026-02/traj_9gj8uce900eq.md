# Trajectory: Define Relaycast telemetry event plan and audit current MCP server telemetry implementation

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 19, 2026 at 04:59 PM
> **Completed:** February 19, 2026 at 05:02 PM

---

## Summary

Audited MCP telemetry implementation and proposed a layered Relaycast telemetry plan with concrete event taxonomy and ownership by surface.

**Approach:** Standard approach

---

## Key Decisions

### Recommend layered telemetry: server as source-of-truth KPIs, CLI/MCP/SDK for funnel and diagnostics
- **Chose:** Recommend layered telemetry: server as source-of-truth KPIs, CLI/MCP/SDK for funnel and diagnostics
- **Reasoning:** Server logs miss pre-connect/setup failures; client-side surfaces capture adoption and failure funnels while preserving minimal anonymous payloads

### Use a shared event envelope across surfaces with optional surface-specific properties
- **Chose:** Use a shared event envelope across surfaces with optional surface-specific properties
- **Reasoning:** This enables comparable funnels and rollups while keeping payloads small and backwards-compatible per client

---

## Chapters

### 1. Work
*Agent: default*

- Recommend layered telemetry: server as source-of-truth KPIs, CLI/MCP/SDK for funnel and diagnostics: Recommend layered telemetry: server as source-of-truth KPIs, CLI/MCP/SDK for funnel and diagnostics
- Use a shared event envelope across surfaces with optional surface-specific properties: Use a shared event envelope across surfaces with optional surface-specific properties
