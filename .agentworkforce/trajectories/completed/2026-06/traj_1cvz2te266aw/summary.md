# Trajectory: Fix agent-relay MCP config

> **Status:** ✅ Completed
> **Confidence:** 95%
> **Started:** June 24, 2026 at 03:50 PM
> **Completed:** June 24, 2026 at 03:50 PM

---

## Summary

Updated ~/.codex/config.toml so mcp_servers.agent-relay runs command agent-relay with args ["mcp"]. Verified the TOML block after editing.

**Approach:** Standard approach

---

## Key Decisions

### Configured Codex Agent Relay MCP to launch the mcp subcommand
- **Chose:** Configured Codex Agent Relay MCP to launch the mcp subcommand
- **Reasoning:** The installed agent-relay CLI exposes the MCP stdio server as 'agent-relay mcp'; bare 'agent-relay' exits after printing help and cannot serve the MCP handshake.

---

## Chapters

### 1. Work
*Agent: default*

- Configured Codex Agent Relay MCP to launch the mcp subcommand: Configured Codex Agent Relay MCP to launch the mcp subcommand
