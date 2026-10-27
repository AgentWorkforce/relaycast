# Trajectory: Keep delivery sequences monotonic across retention

> **Status:** ✅ Completed
> **Task:** relaycast#252
> **Confidence:** 95%
> **Started:** July 10, 2026 at 10:00 AM
> **Completed:** July 10, 2026 at 10:12 AM

---

## Summary

Fixed Relaycast #252 with a durable per-agent delivery sequence high-water, atomic trigger-backed allocation, migration repair for replay-hidden active rows, and regression coverage for retention, cascades, offline replay/ACK, migration backfill/FIFO repair, and concurrency

**Approach:** Standard approach

---

## Key Decisions

### Store delivery sequence high-water on agents and advance it with an AFTER INSERT trigger
- **Chose:** Store delivery sequence high-water on agents and advance it with an AFTER INSERT trigger
- **Reasoning:** A persistent counter survives both explicit delivery pruning and message-cascade deletion. The trigger makes allocation and advancement one SQLite statement across Node, D1 batch, and bare sequential adapters; migration repair renumbers all active rows for affected agents above max(ACK, existing seq) in FIFO order.

---

## Chapters

### 1. Work
*Agent: default*

- Store delivery sequence high-water on agents and advance it with an AFTER INSERT trigger: Store delivery sequence high-water on agents and advance it with an AFTER INSERT trigger
