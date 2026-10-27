# Trajectory: Dead-letter deliveries routed to long-offline nodes (frees workspace depth cap)

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** October 11, 2026
> **Completed:** October 11, 2026

---

## Summary

Added `sweepUnreachableDeliveries` / `deadLetterUnreachableDeliveryBatch`: a bounded, batched drain that dead-letters active deliveries whose `location_node_id` points at a node offline longer than a grace window (default 30m), emitting `delivery.failed` sender notices with `reason: 'node_unreachable'`. Frees workspace delivery-depth capacity held by mail that can never dispatch — the measured prod anomaly was 1,686 deliveries pinned on ~286 agents whose bound nodes had been offline ~75min, all sitting until their ~2h TTL.

**Approach:** Mirrors the existing `sweepExpiredDeliveries` shape (chunked stale-node select → bounded delivery select → guarded dead-letter update → per-batch notice flush). Nodes with `last_heartbeat_at IS NULL` are excluded so a never-connected node isn't treated as permanently dead.

---

## Key Decisions

### Dead-letter on node-unreachability rather than TTL-bump or send-time rejection
- **Chose:** scheduled sweep that dead-letters deliveries on nodes offline > grace, reuse of existing expiry notice machinery
- **Reasoning:** senders get an authoritative `delivery.failed` signal (retryable=false) instead of silent queuing; bounded batches avoid creating a new D1 hotspot; no schema or API contract change required.

---

## Artifacts

**PR:** AgentWorkforce/relaycast#529
**Commits:** cba96422
**Files changed:** delivery.ts, deliveryRouting.ts, index.ts, unreachableDeliveryReap.test.ts, 2× CHANGELOG.md
