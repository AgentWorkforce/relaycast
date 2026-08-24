# Trajectory: Make action idempotency claim durable before dispatch

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relaycast#355
> **Confidence:** 96%
> **Started:** August 24, 2026 at 02:14 AM
> **Completed:** August 24, 2026 at 02:24 AM

---

## Summary

Replaced action-invoke's post-dispatch KV idempotency record with an atomic durable invocation-row claim before provider dispatch. Same-key concurrency and lost-response retries replay one invocation, mismatched payloads fail 409, and SDK retries preserve one key.

**Approach:** Review-driven durability correction with incident-specific concurrency and failure-injection regressions

---

## Key Decisions

### Use the action_invocations primary key as the durable pre-dispatch claim
- **Chose:** Use the action_invocations primary key as the durable pre-dispatch claim
- **Reasoning:** Derive an invocation id from SHA-256(workspace, authenticated caller, action name, Idempotency-Key), insert that invocation row with ON CONFLICT DO NOTHING before placement/provider dispatch, and replay the existing row on conflict. The database primary key is atomic across isolates and survives KV/result-write failure; it also makes a second payload under the same scoped key an explicit 409. This replaces the post-dispatch KV record whose write-failure window CodeRabbit correctly identified. The at-most-once trade-off is that an isolate death after the claim insert but before dispatch can leave a pending invocation for existing reconciliation/TTL handling, but a retry cannot execute the provider twice.

---

## Chapters

### 1. Work
*Agent: default*

- Use the action_invocations primary key as the durable pre-dispatch claim: Use the action_invocations primary key as the durable pre-dispatch claim
- CodeRabbit's atomicity finding replaced the initial post-dispatch KV record with a deterministic action_invocations primary-key claim inserted before dispatch. Concurrent keyed spawn and registered-action tests now prove one row and one provider frame even when KV writes fail; immutable handler and node identity survive action takeover, payload comparison is canonical, and replay-only webhook, telemetry, observer, placement, and capacity effects are suppressed. Node 22 validation is green: engine 681/681, SDK 436/436, focused concurrency suites, engine build/typecheck/lint, and SDK build/lint.
