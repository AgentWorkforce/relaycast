# Trajectory: Investigate e2e agent disconnect status not showing grey

> **Status:** ✅ Completed
> **Confidence:** 89%
> **Started:** February 17, 2026 at 08:59 PM
> **Completed:** February 17, 2026 at 09:05 PM

---

## Summary

Fixed dashboard presence disconnect updates by normalizing PresenceDO online/offline payloads to canonical {agent:{name}} shape, separating presence subject from AgentDO recipient metadata, and propagating agent names through heartbeat/disconnect paths with test coverage.

**Approach:** Standard approach

---

## Key Decisions

### PresenceDO should emit canonical agent events and preserve recipient identity in AgentDO metadata
- **Chose:** PresenceDO should emit canonical agent events and preserve recipient identity in AgentDO metadata
- **Reasoning:** Dashboard reducers and SDK schemas expect agent.online/offline as { agent: { name } }. PresenceDO was emitting agentId-only payloads and reusing agentId for both subject and recipient, which prevented UI status updates and could poison AgentDO ping/disconnect metadata.

### Carry agentName through heartbeat/disconnect calls and cache it in PresenceDO
- **Chose:** Carry agentName through heartbeat/disconnect calls and cache it in PresenceDO
- **Reasoning:** Presence events need stable display names without extra DB lookups and for stale-alarm offline events where only agent IDs are available.

---

## Chapters

### 1. Work
*Agent: default*

- PresenceDO should emit canonical agent events and preserve recipient identity in AgentDO metadata: PresenceDO should emit canonical agent events and preserve recipient identity in AgentDO metadata
- Carry agentName through heartbeat/disconnect calls and cache it in PresenceDO: Carry agentName through heartbeat/disconnect calls and cache it in PresenceDO
