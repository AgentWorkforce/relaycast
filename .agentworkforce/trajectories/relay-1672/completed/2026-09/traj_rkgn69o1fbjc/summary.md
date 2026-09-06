# Trajectory: Make Relaycast release cleanup generation-safe

> **Status:** ✅ Completed
> **Task:** Relay #1672
> **Confidence:** 90%
> **Started:** September 6, 2026 at 08:36 AM
> **Completed:** September 6, 2026 at 9:14 AM

---

## Summary

Added SHA-256 token-generation guarded releases across Relaycast types, engine, OpenAPI, TypeScript SDK, and Rust SDK, with takeover, drain, retry, reconciliation, replay, completion-race, action-shadow, and custom-action isolation regressions plus atomic dispatch/completion enforcement. Invocation origin is now immutable across registered-action pruning, so a deleted custom action cannot acquire built-in lifecycle authority or be rebound by name to a replacement handler.

**Product commits:** `2951bcb435a578c4bfc35c4b9b62c4455857a052`, `fd4208e84a45661a4dd58468e918ef879e2c57dc`, `99c31ea9d4b9298e43d6da0b726f1a20119467a8`, `0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`, `038af6af9ad61e53e08790fb5ffa3051f3017951`, `90b9711882460236c52a3a03f4025bf5361b8eeb`, `cd935897bd3ea9de39f98844c5e7e768653cc84e`, `7e91c060bce63dd6340977c548f7ee3fc4f071d4`, `e0f7757c17e4f9d85b079190e8734c6d5846430c`, `da79986f776393aa491a85450b2474d2c0b2bdc5`, `2e61bfccdb0247a58f8a6bf8742d59162580a1ab`, `64b199b0e2cf72fc913a1882e1771bb67dd92420`, `f6a219f0ebc3f6db6a3a517588802f4316c774cd`

**Attribution range:** `80ab366048a0634fbf1a8b5301de71dd22c50026..f6a219f0ebc3f6db6a3a517588802f4316c774cd`

**Changed product files:** `CHANGELOG.md`, `README.md`, `openapi.yaml`, four package changelogs, the engine route/action/realtime contract, schema and migration, Node adapter, five engine conformance suites and migration tests, TypeScript SDK tests, and Rust SDK implementation/parity tests. The exact list is recorded in `trajectory.json`.

**Approach:** Standard approach

---

## Key Decisions

### Use a SHA-256 token-generation verifier for release compare-and-swap

- **Chose:** Use a SHA-256 token-generation verifier for release compare-and-swap
- **Reasoning:** Relaycast takeover deliberately preserves the agent ID while rotating the credential, so the ID cannot distinguish process generations. Persisting and comparing only the token hash binds cleanup to the exact issued generation without storing or transmitting the raw token.

---

## Verification provenance

- On exact product head `f6a219f0ebc3f6db6a3a517588802f4316c774cd`, this trajectory reran root lint, test (including the full engine suite: 70 files / 767 tests), and build. Three must-fire regressions for retry, queued drain, and inventory reconciliation each failed on the preceding product head by either rebinding a pruned registered action to a same-name replacement or leaving it pending, then passed by settling the orphaned invocation as `action_deleted`. The two capability-pruning custom-release regressions likewise failed on their preceding product head by deactivating the named agent and binding after `action_id` became null, then passed once immutable invocation provenance replaced mutable-FK inference. The migration regression proves registered provenance is backfilled while all ambiguous open legacy invocations fail closed. Earlier custom-release completion, release-action shadow, and replay-classification regressions likewise failed on their preceding product heads and passed after their fixes.
- On product head `2951bcb435a578c4bfc35c4b9b62c4455857a052`, this trajectory ran the TypeScript SDK (22 files / 441 tests), types package (7 files / 209 tests), Rust SDK (103 tests plus 5 doc tests), and Rust library clippy. Those package code and test files are unchanged through final product head `f6a219f0ebc3f6db6a3a517588802f4316c774cd`; later engine-only commits harden lifecycle routing and raise no SDK surface changes.

## Chapters

### 1. Work

*Agent: default*

- Exact token-hash guards fail closed at route, dispatch, socket-owner authorization, drain/retry, and atomic completion while legacy unguarded callers remain compatible; the dedicated agent lifecycle route cannot be shadowed by a registered action, and a custom action named `release` remains generic.
- Idempotent replays preserve the durable generation-conflict response, and an accepted socket send cannot fall through to local deletion when an older adapter rejects the proof or a completion wins before the dispatch stamp.
- Built-in lifecycle authority is recorded independently from the nullable action foreign key; provider capability refreshes may prune the referenced custom action without reclassifying its in-flight invocation.
- Retry, queued drain, and inventory reconciliation fail a pruned registered action as `action_deleted` instead of resolving its stale name to a replacement registration.
