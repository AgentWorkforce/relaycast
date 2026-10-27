# Trajectory: Fix cursor-negotiated provider replay ordering

> **Status:** ✅ Completed
> **Task:** relaycast#254
> **Confidence:** 92%
> **Started:** July 11, 2026 at 08:26 AM
> **Completed:** July 11, 2026 at 08:32 AM

---

## Summary

Scoped node mailbox replay by provider and cursor-ready agent, documented inventory continuity, and added restart regression coverage.

**Approach:** Standard approach

---

## Key Decisions

### Scope mailbox replay by provider and ready agent identity
- **Chose:** Scope mailbox replay by provider and ready agent identity
- **Reasoning:** A cursor-capable provider cannot replay at node.register. Agent registration must drain only the replied agent, inventory sync must drain only the provider's listed live identities, and legacy node registration must keep immediate replay without touching other providers.

---

## Chapters

### 1. Work
*Agent: default*

- Scope mailbox replay by provider and ready agent identity: Scope mailbox replay by provider and ready agent identity
- Replay gating now covers cursor reply ordering, per-agent drains, provider isolation, and inventory-based transport continuity; focused and full engine tests pass after rerunning the listener test outside the sandbox.
