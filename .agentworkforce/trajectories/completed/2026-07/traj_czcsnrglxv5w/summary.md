# Trajectory: Fix issue #241: idempotent action registration, fail-fast on dead handlers, SDK schema casing

> **Status:** ✅ Completed
> **Task:** relaycast#241
> **Confidence:** 85%
> **Started:** July 16, 2026 at 04:41 AM
> **Completed:** July 16, 2026 at 04:41 AM

---

## Summary

Fixed all three #241 defects: POST /v1/actions is an idempotent upsert (onConflictDoUpdate against the agent-hosted partial index and the node index; 200 refresh vs 201 create; residual races 409); invokeAction fails fast with 503 handler_unavailable when the handler agent's connection is not live and sweepTimedOutInvocations fails still-unreachable agent-handled invocations after a 2min TTL with action.failed emission; SDK casing transforms pass input_schema/output_schema/input/output/headers verbatim both directions. 6 new conformance tests + SDK casing round-trip tests; all 474 engine + 391 SDK tests green; openapi/README/changelogs updated.

**Approach:** Standard approach

---

## Key Decisions

### Upsert allows handler takeover by a different agent
- **Chose:** Upsert allows handler takeover by a different agent
- **Reasoning:** The workspace is the trust boundary (agent tokens are already restricted to self-handled registration); takeover is exactly the recovery path when a publisher reconnects under a fresh identity. User was unreachable for AskUserQuestion, so recommended option chosen and flagged in the PR.

### Fail-fast at invoke plus bounded 2-minute TTL sweep, not TTL-only
- **Chose:** Fail-fast at invoke plus bounded 2-minute TTL sweep, not TTL-only
- **Reasoning:** Invoke-time 503 handler_unavailable gives LLM callers an in-context recoverable error; the TTL sweep (only fails when the handler is still unreachable, emitting action.failed) bounds races and post-dispatch node loss without killing slow-but-connected handlers.

### SDK casing exemption covers input/output payloads and headers, not metadata
- **Chose:** SDK casing exemption covers input/output payloads and headers, not metadata
- **Reasoning:** Invocation payloads are user-authored JSON with the same corruption mode as schemas; metadata round-trips consistently through the TS SDK today so changing it has wider blast radius for stored data.

---

## Chapters

### 1. Work
*Agent: default*

- Upsert allows handler takeover by a different agent: Upsert allows handler takeover by a different agent
- Fail-fast at invoke plus bounded 2-minute TTL sweep, not TTL-only: Fail-fast at invoke plus bounded 2-minute TTL sweep, not TTL-only
- SDK casing exemption covers input/output payloads and headers, not metadata: SDK casing exemption covers input/output payloads and headers, not metadata
