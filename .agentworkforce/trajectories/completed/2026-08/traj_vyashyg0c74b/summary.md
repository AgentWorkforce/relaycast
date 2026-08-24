# Trajectory: Make action invocation retries idempotent

> **Status:** ✅ Completed
> **Task:** AgentWorkforce/relaycast#354
> **Confidence:** 93%
> **Started:** August 24, 2026 at 01:49 AM
> **Completed:** August 24, 2026 at 02:04 AM

---

## Summary

Made action invocation retries idempotent across the TypeScript SDK and engine: stable per-call keys survive HttpClient retries, keyed replays return the original invocation, mismatched reuse is rejected, duplicate provider/event effects are suppressed, and the HTTP/README/changelog contracts are documented.

**Approach:** Standard approach

---

## Key Decisions

### Use the existing route-level idempotency contract for action invocation
- **Chose:** Use the existing route-level idempotency contract for action invocation
- **Reasoning:** POST /actions/:name/invoke will scope the caller-supplied key by workspace, authenticated agent, and action name, fingerprint the action input, require KV before a keyed mutation, and store the original 201 response. The TypeScript SDK already has a one-key-per-logical-call helper whose request options survive HttpClient retries, so extending actions.invoke with it fixes the observed committed-response-loss retry without a migration or a second dedupe protocol. The existing middleware is not a transactional D1/provider-dispatch unit: a storage failure after provider dispatch remains an ambiguous edge, which is accepted here because the required incident path is a completed first request whose response is lost; a durable invocation-table key would be a broader follow-up.

---

## Chapters

### 1. Work
*Agent: default*

- Use the existing route-level idempotency contract for action invocation: Use the existing route-level idempotency contract for action invocation
- Action invocation now carries one stable SDK key through transport retries; the engine replays the original 201 response, rejects payload reuse, and suppresses duplicate provider, webhook, telemetry, and observer effects. Focused and full Node 22 suites are green (engine 678/678, SDK 436/436), builds/typecheck and package linters pass.
