# Trajectory: SDK WS reconnect resync: track agent_seq, send resync on reconnect, dedupe replays, emit resynced

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** June 9, 2026 at 04:01 PM
> **Completed:** June 9, 2026 at 04:01 PM

---

## Summary

SDK WS clients now speak the server resync protocol: WsClient tracks agent_seq, sends {type:resync,last_seen_seq,since} after reconnect, dedupes replayed events by stable id, and emits a resynced lifecycle event surfaced as on.resynced on RelayCast/AgentClient. Added resync/resync_ack/resynced frame types to @relaycast/types, package README, and unit tests (fresh-connect no-op, seq tracking, frame ordering, dedupe, ack stats).

**Approach:** Standard approach

---

## Key Decisions

### Read agent_seq from the raw WS frame before zod parsing
- **Chose:** Read agent_seq from the raw WS frame before zod parsing
- **Reasoning:** ServerEventSchema z.object strips unknown keys, so the seq stamp is only visible pre-parse; tracking it in WsClient.onmessage keeps the schema surface unchanged

### Dedupe replays by stable event id LRU (2048) instead of seq comparison
- **Chose:** Dedupe replays by stable event id LRU (2048) instead of seq comparison
- **Reasoning:** DB-fallback replay events carry no agent_seq and seq-based dropping would silently discard live events after a server counter reset; id dedupe covers the message events that matter

### Send resync after emitting open so consumer open-handlers resubscribe first
- **Chose:** Send resync after emitting open so consumer open-handlers resubscribe first
- **Reasoning:** Matches the task contract: resync follows the auth/subscribe handshake; AgentClient resubscribes synchronously in its open handler

---

## Chapters

### 1. Work
*Agent: default*

- Read agent_seq from the raw WS frame before zod parsing: Read agent_seq from the raw WS frame before zod parsing
- Dedupe replays by stable event id LRU (2048) instead of seq comparison: Dedupe replays by stable event id LRU (2048) instead of seq comparison
- Send resync after emitting open so consumer open-handlers resubscribe first: Send resync after emitting open so consumer open-handlers resubscribe first
