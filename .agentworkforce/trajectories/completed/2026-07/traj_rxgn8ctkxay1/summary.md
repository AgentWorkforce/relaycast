# Trajectory: Negotiate authoritative delivery cursor with Relay broker

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relay#1240
> **Confidence:** 94%
> **Started:** July 10, 2026 at 10:14 AM
> **Completed:** July 10, 2026 at 10:14 AM

---

## Summary

Added capability-gated delivery_ack_seq replies before pending mailbox replay, with legacy broker compatibility and conformance coverage.

**Approach:** Standard approach

---

## Key Decisions

### Gate delivery_ack_seq behind a registered node capability
- **Chose:** Gate delivery_ack_seq behind a registered node capability
- **Reasoning:** Older Relay brokers reject unknown agent.register reply fields. Capability negotiation lets new brokers receive the authoritative cursor before replay while preserving the exact legacy reply shape for old brokers.

---

## Chapters

### 1. Work
*Agent: default*

- Gate delivery_ack_seq behind a registered node capability: Gate delivery_ack_seq behind a registered node capability
