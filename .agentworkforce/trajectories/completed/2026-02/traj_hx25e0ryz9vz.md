# Trajectory: Add origin attribution parameters from SDK/MCP into server telemetry metadata

> **Status:** ✅ Completed
> **Confidence:** 96%
> **Started:** February 19, 2026 at 05:46 PM
> **Completed:** February 19, 2026 at 05:46 PM

---

## Summary

Implemented origin attribution endpoint parameters for server telemetry, propagated origin metadata through SDK HTTP+WS clients and MCP server, added tests for server logging and SDK behavior, and documented accepted origin parameters in TELEMETRY.md.

**Approach:** Standard approach

---

## Key Decisions

### Use explicit origin endpoint parameters with header-over-query precedence
- **Chose:** Use explicit origin endpoint parameters with header-over-query precedence
- **Reasoning:** HTTP calls can reliably send headers while WebSocket upgrades need query parameters; precedence prevents ambiguity when both are present

### Default SDK origin metadata to sdk/@relaycast/sdk and override to mcp in MCP server
- **Chose:** Default SDK origin metadata to sdk/@relaycast/sdk and override to mcp in MCP server
- **Reasoning:** Provides attribution automatically for existing SDK users while ensuring MCP traffic is distinguished without requiring user configuration

---

## Chapters

### 1. Work
*Agent: default*

- Use explicit origin endpoint parameters with header-over-query precedence: Use explicit origin endpoint parameters with header-over-query precedence
- Default SDK origin metadata to sdk/@relaycast/sdk and override to mcp in MCP server: Default SDK origin metadata to sdk/@relaycast/sdk and override to mcp in MCP server
