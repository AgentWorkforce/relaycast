# Trajectory: Relaycast D1 robustness: slim node.heartbeat statement count

> **Status:** ✅ Completed
> **Confidence:** 85%
> **Started:** October 11, 2026 at 12:44 PM
> **Completed:** October 11, 2026 at 01:04 PM

---

## Summary

Slimmed node.heartbeat to batched read/write groups with unchanged-capability action skip plus a drift check that re-materializes on out-of-band action changes. Review fix: drift check now derives expected is_global (default provider loses the alias to agent-hosted or foreign-global rows, reclaims when they disappear) so shadowed actions self-heal.

**Approach:** Standard approach

---

## Key Decisions

### Single provider write + drift-gated materialize skip + provenLiveAt folded into aggregate
- **Chose:** Single provider write + drift-gated materialize skip + provenLiveAt folded into aggregate
- **Reasoning:** Broker sends capabilities every ~12s beat; heartbeatNode issued ~15 sequential D1 statements (two provider SELECT+UPDATE pairs, per-cap materialize, separate provenLiveAt write, trailing readback). Merged provider upsert+heartbeat into one write; materialize only runs when caps changed or a one-read drift check sees missing/stale action rows (preserves the self-heal the nodeProviders conformance suite pins); provenLiveAt folded into recomputeNodeAggregate's UPDATE which now RETURNINGs the row, dropping the trailing SELECT. ~15 -> ~6 statements/beat.

---

## Chapters

### 1. Initial work
*Agent: devin-relaycast-robust*

- Single provider write + drift-gated materialize skip + provenLiveAt folded into aggregate: Single provider write + drift-gated materialize skip + provenLiveAt folded into aggregate

---

## Artifacts

**Commits:** af2e2f52, b27e7b29
**Files changed:** 9
