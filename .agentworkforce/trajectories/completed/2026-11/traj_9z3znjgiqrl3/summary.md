# Trajectory: Deliver authenticated Relayfile deleted events

> **Status:** ✅ Completed
> **Confidence:** 93%
> **Started:** November 6, 2026 at 01:36 AM
> **Completed:** November 6, 2026 at 01:41 AM

---

## Summary

Relayfile deleted events now pass existing authenticated target and idempotency controls; snapshot-free notifications are labeled honestly. Baseline reproduced 2 failures; patched receiver plus related delivery/idempotency suites pass 34 tests, and engine typecheck passes. No deployed/runtime changes.

**Approach:** Standard approach

---

## Key Decisions

### Accept authenticated file.deleted under the existing inbound target contract
- **Chose:** Accept authenticated file.deleted under the existing inbound target contract
- **Reasoning:** Fresh origin/main OpenAPI already advertises deletes; preserve signature, target matching, agent-write exclusion and event-ID deduplication, with envelope-only formatting when content is absent.

---

## Chapters

### 1. Work
*Agent: default*

- Accept authenticated file.deleted under the existing inbound target contract: Accept authenticated file.deleted under the existing inbound target contract
