# Trajectory: Restore telemetry in cf-deploy branch (MCP in worker runtime)

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** February 17, 2026 at 10:11 PM
> **Completed:** February 17, 2026 at 10:12 PM

---

## Summary

Restored MCP telemetry delivery in Cloudflare worker runtime by preferring fetch transport, preserving node request fallback, and adding regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Use fetch-based PostHog transport in MCP telemetry with node:http/https fallback
- **Chose:** Use fetch-based PostHog transport in MCP telemetry with node:http/https fallback
- **Reasoning:** Cloudflare Durable Objects cannot rely on node:http sockets; fetch works in Workers and Node 18+, while fallback preserves compatibility

---

## Chapters

### 1. Work
*Agent: default*

- Use fetch-based PostHog transport in MCP telemetry with node:http/https fallback: Use fetch-based PostHog transport in MCP telemetry with node:http/https fallback
