# Trajectory: Fix server reliability and performance issues from review

> **Status:** ✅ Completed
> **Confidence:** 90%
> **Started:** February 17, 2026 at 09:44 PM
> **Completed:** February 17, 2026 at 09:49 PM

---

## Summary

Implemented server reliability/performance fixes: durable queue webhook delivery semantics, workspace-scoped inbound webhooks with system agent identity, DM/inbox/search batching, D1-safe reaction idempotency, and restored green build/tests

**Approach:** Standard approach

---

## Key Decisions

### Implement reliability and hot-path query fixes before API-level behavior changes
- **Chose:** Implement reliability and hot-path query fixes before API-level behavior changes
- **Reasoning:** Fixing durability and performance bugs first reduces user-facing risk while preserving existing endpoint contracts where possible

### Use a contract-first parity plan for a native Rust relaycast binary
- **Chose:** Use a contract-first parity plan for a native Rust relaycast binary
- **Reasoning:** Current source-of-truth is split across route code, SDK behavior, and outdated OpenAPI. Locking a runtime contract first avoids porting drift and prevents regressions during Cloudflare primitive replacement.

### Model Durable Objects as in-process Rust actors with persisted sequence state
- **Chose:** Model Durable Objects as in-process Rust actors with persisted sequence state
- **Reasoning:** AgentDO, ChannelDO, PresenceDO, and McpSessionDO rely on single-threaded per-key ordering semantics. Tokio actor sharding keyed by workspace/agent/channel/session preserves behavior while remaining deployable as one local binary.

### Made inbound webhook management workspace-key only with deterministic system posting identity
- **Chose:** Made inbound webhook management workspace-key only with deterministic system posting identity
- **Reasoning:** Webhooks are workspace-level integrations, but message rows require agent_id; provisioning a system agent prevents untriggerable webhooks

### Reworked DM/inbox/search paths to batch queries and deterministic 1:1 DM IDs
- **Chose:** Reworked DM/inbox/search paths to batch queries and deterministic 1:1 DM IDs
- **Reasoning:** Eliminates N+1 query patterns and reduces duplicate 1:1 conversation races under concurrent sends

---

## Chapters

### 1. Work
*Agent: default*

- Implement reliability and hot-path query fixes before API-level behavior changes: Implement reliability and hot-path query fixes before API-level behavior changes
- Use a contract-first parity plan for a native Rust relaycast binary: Use a contract-first parity plan for a native Rust relaycast binary
- Model Durable Objects as in-process Rust actors with persisted sequence state: Model Durable Objects as in-process Rust actors with persisted sequence state
- Made inbound webhook management workspace-key only with deterministic system posting identity: Made inbound webhook management workspace-key only with deterministic system posting identity
- Reworked DM/inbox/search paths to batch queries and deterministic 1:1 DM IDs: Reworked DM/inbox/search paths to batch queries and deterministic 1:1 DM IDs
