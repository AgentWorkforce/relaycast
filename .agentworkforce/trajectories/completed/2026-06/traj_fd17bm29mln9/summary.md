# Trajectory: Diagnose agent-relay MCP failure

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** June 24, 2026 at 03:34 PM
> **Completed:** June 24, 2026 at 03:36 PM

---

## Summary

Diagnosed Agent Relay MCP failure: ~/.codex/config.toml launches bare agent-relay, but the CLI's MCP stdio server is agent-relay mcp. Bare command prints CLI help and exits during MCP initialization.

**Approach:** Standard approach

---

## Key Decisions

### Diagnosed Agent Relay MCP startup failure as missing mcp subcommand
- **Chose:** Diagnosed Agent Relay MCP startup failure as missing mcp subcommand
- **Reasoning:** Codex config launches command=agent-relay with no args. The installed CLI shows MCP is served by 'agent-relay mcp', while bare 'agent-relay' prints help and exits, which is not a valid MCP stdio server.

---

## Chapters

### 1. Work
*Agent: default*

- Diagnosed Agent Relay MCP startup failure as missing mcp subcommand: Diagnosed Agent Relay MCP startup failure as missing mcp subcommand

---

## Artifacts

**Commits:** 534f416
**Files changed:** 12
