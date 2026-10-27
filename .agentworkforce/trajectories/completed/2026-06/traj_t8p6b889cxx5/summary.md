# Trajectory: Stack PR on current PR 213 for issue 213

> **Status:** ✅ Completed
> **Confidence:** 86%
> **Started:** June 25, 2026 at 08:07 AM
> **Completed:** June 25, 2026 at 08:29 AM

---

## Summary

Opened stacked scoped observer token PR with engine contract, SDK parity, docs, and review fixes for muted thread mentions plus response-mode http_push ack handling.

**Approach:** Standard approach

---

## Key Decisions

### Stack observer-token implementation on current PR 214 branch
- **Chose:** Stack observer-token implementation on current PR 214 branch
- **Reasoning:** Issue #213 is an issue, not a pull request; the checked-out branch is PR #214, so the new PR should target codex/node-kind-role-adapter.

### Require observer tokens on workspace WebSocket
- **Chose:** Require observer tokens on workspace WebSocket
- **Reasoning:** Issue #213 acceptance criteria allows final major-upgrade behavior; current PR already makes workspace realtime observer-only, so /v1/ws should require ot_live_* with stream:read instead of accepting rk_live_* admin keys.

### Addressed review by preserving mention deliveries through mutes on thread replies and keeping response-mode HTTP push deliveries retryable until an explicit ack signal
- **Chose:** Addressed review by preserving mention deliveries through mutes on thread replies and keeping response-mode HTTP push deliveries retryable until an explicit ack signal
- **Reasoning:** Mention intent must override channel mute filtering, and response-mode webhooks are part of the ack lifecycle so a 2xx without ack cannot become terminal delivered.

---

## Chapters

### 1. Work
*Agent: default*

- Stack observer-token implementation on current PR 214 branch: Stack observer-token implementation on current PR 214 branch
- Require observer tokens on workspace WebSocket: Require observer tokens on workspace WebSocket
- Engine observer-token implementation is passing focused and full engine tests; remaining work is SDK surface, README/OpenAPI contract docs, and final build/test validation.
- Addressed review by preserving mention deliveries through mutes on thread replies and keeping response-mode HTTP push deliveries retryable until an explicit ack signal: Addressed review by preserving mention deliveries through mutes on thread replies and keeping response-mode HTTP push deliveries retryable until an explicit ack signal

---

## Artifacts

**Commits:** b32d86a
**Files changed:** 48
