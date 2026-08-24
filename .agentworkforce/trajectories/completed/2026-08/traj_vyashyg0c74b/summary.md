# Trajectory: Make action invocation retries idempotent

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relaycast#354
> **Confidence:** 93%
> **Started:** August 24, 2026 at 01:49 AM
> **Completed:** August 24, 2026 at 02:04 AM

---

## Summary

Made action invocation retries durable across the TypeScript SDK and engine: stable per-call keys survive HttpClient retries, an atomic pre-dispatch invocation claim prevents duplicate provider execution, keyed replays return the original invocation, mismatched reuse is rejected, and duplicate event effects are suppressed.

**Approach:** Standard approach

---

## Key Decisions

### Replace the initial KV coordinator with a durable pre-dispatch invocation claim
- **Chose:** Replace the initial KV coordinator with a durable pre-dispatch invocation claim
- **Reasoning:** The first implementation used the shared route-level KV coordinator, but review proved its non-atomic lock and post-dispatch result write could both permit duplicate provider execution. The final design derives a deterministic invocation id from the workspace, authenticated caller, action name, and key, then atomically inserts that `action_invocations` primary-key claim before provider dispatch. A conflict replays the existing invocation and a payload mismatch returns 409; KV failure cannot reopen the key.

---

## Chapters

### 1. Work
*Agent: default*

- Replace the initial KV coordinator with a durable pre-dispatch invocation claim: Replace the initial KV coordinator with a durable pre-dispatch invocation claim
- Action invocation now carries one stable SDK key through transport retries; the engine atomically claims a deterministic invocation row with immutable handler and node identity before provider dispatch, replays that invocation, rejects payload reuse, and suppresses duplicate provider, webhook, telemetry, and observer effects. Focused and full Node 22 suites are green (engine 681/681, SDK 436/436), builds/typecheck and package linters pass.
