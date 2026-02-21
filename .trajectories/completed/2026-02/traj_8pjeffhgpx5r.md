# Trajectory: Bring openapi.yaml up to date with all mounted API routes

> **Status:** ✅ Completed
> **Confidence:** 91%
> **Started:** February 20, 2026 at 01:47 PM
> **Completed:** February 20, 2026 at 01:50 PM

---

## Summary

Updated openapi.yaml to include all currently mounted API routes, added missing methods, documented MCP discovery/transport and websocket stream, and validated YAML + route coverage

**Approach:** Standard approach

---

## Key Decisions

### Expanded OpenAPI coverage to match mounted worker routes
- **Chose:** Expanded OpenAPI coverage to match mounted worker routes
- **Reasoning:** Spec previously covered only core messaging APIs and missed active billing/file/webhook/command/presence/stream/read-receipt endpoints

---

## Chapters

### 1. Work
*Agent: default*

- Expanded OpenAPI coverage to match mounted worker routes: Expanded OpenAPI coverage to match mounted worker routes
