# Trajectory: Make Relaycast release cleanup generation-safe

> **Status:** ✅ Completed
> **Task:** Relay #1672
> **Confidence:** 90%
> **Started:** September 6, 2026 at 08:36 AM
> **Completed:** September 6, 2026 at 9:53 AM

---

## Summary

Added SHA-256 token-generation guarded releases across Relaycast types, engine, OpenAPI, TypeScript SDK, and Rust SDK, with takeover, drain, retry, reconciliation, replay, completion-race, action-shadow, custom-action isolation, migration-capacity, reservation-ownership, concurrent-rebind, and concurrent action-prune regressions plus atomic dispatch/completion enforcement. Invocation origin is now immutable across registered-action pruning, and retry handoff atomically compares its exact source action generation before binding a live replacement, so a prune that wins the race cannot dispatch by stale name. Migration-failed spawns remain durable cancellation tombstones even when legacy workers omit invocation correlation, live reservations are claimable only by their exact invocation/name/provider, and nontransactional registration acquires capacity before writes with exact-identity compensation for later failure.

**Product commits:** `2951bcb435a578c4bfc35c4b9b62c4455857a052`, `fd4208e84a45661a4dd58468e918ef879e2c57dc`, `99c31ea9d4b9298e43d6da0b726f1a20119467a8`, `0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`, `038af6af9ad61e53e08790fb5ffa3051f3017951`, `90b9711882460236c52a3a03f4025bf5361b8eeb`, `cd935897bd3ea9de39f98844c5e7e768653cc84e`, `7e91c060bce63dd6340977c548f7ee3fc4f071d4`, `e0f7757c17e4f9d85b079190e8734c6d5846430c`, `da79986f776393aa491a85450b2474d2c0b2bdc5`, `2e61bfccdb0247a58f8a6bf8742d59162580a1ab`, `64b199b0e2cf72fc913a1882e1771bb67dd92420`, `f6a219f0ebc3f6db6a3a517588802f4316c774cd`, `4e85e36a62577e1ae8e14ecb2401bcf16002a0c1`, `984c575d11cf25fc16f19182065a671834b6030c`, `91c791f86a7db00ed29be61a42f9ab931e890c49`, `0d91d76c180ee720120b58af5753e95f1868a71f`

**Attribution range:** `80ab366048a0634fbf1a8b5301de71dd22c50026..0d91d76c180ee720120b58af5753e95f1868a71f`

**Changed product files:** `CHANGELOG.md`, `README.md`, `openapi.yaml`, four package changelogs, the engine route/action/realtime contract, schema and migration, Node adapter, five engine conformance suites and migration tests, TypeScript SDK tests, and Rust SDK implementation/parity tests. The exact list is recorded in `trajectory.json`.

**Approach:** Standard approach

---

## Key Decisions

### Use a SHA-256 token-generation verifier for release compare-and-swap

- **Chose:** Use a SHA-256 token-generation verifier for release compare-and-swap
- **Reasoning:** Relaycast takeover deliberately preserves the agent ID while rotating the credential, so the ID cannot distinguish process generations. Persisting and comparing only the token hash binds cleanup to the exact issued generation without storing or transmitting the raw token.

### Bind released spawn capacity to durable cancellation and exact reservation ownership

- **Chose:** Bind released spawn capacity to durable cancellation and exact reservation ownership
- **Reasoning:** Migration must free otherwise permanent capacity without admitting a worker from an already-terminalized frame. The failed invocation id is an immutable cancellation tombstone, while a live reservation is claimable only by the same invocation, provider, node, and requested agent name. This preserves capacity without reintroducing same-name replacement authority.

---

## Verification provenance

- On exact product head `0d91d76c180ee720120b58af5753e95f1868a71f`, this trajectory reran root lint (13/13), test (18/18, including the full engine suite: 70 files / 774 tests), and build (9/9). A nontransactional D1-shaped capacity regression first failed with a durable ghost agent and now proves capacity is acquired before agent or membership writes. A forced post-reservation binding failure further proves compensation deletes the exact new identity, its membership and binding, and releases its slot. A migration-canceled worker without `invocation_id` first bypassed the tombstone and now fails closed by its persisted node/provider/name tuple while an unrelated uncorrelated registration still succeeds. The upgrade regression failed on a preceding product head with a native spawn reservation stranded at two slots, then passed with migration-time counter reconciliation and marker clearing. A later migration regression proved the released provider-owned reservation admitted its late worker beside a replacement reservation, and the live-reservation regression proved an unrelated registration could steal a slot; both now pass through durable cancellation and exact invocation/name/provider ownership. The concurrent-rebind regression proved a local release returned/emitted the stale pre-transaction host and now passes by recording the binding selected inside the atomic completion. Three must-fire regressions for retry, queued drain, and inventory reconciliation each failed on preceding product heads by either rebinding a pruned registered action to a same-name replacement or leaving it pending, then passed by settling the orphaned invocation as `action_deleted`. A later deterministic interleaving pruned the exact source action after retry selected a same-name replacement and failed on preceding head `7a853fcc2d51a2061243538520ec246c85dbd247` by delivering that replacement frame; it now passes through the atomic source-generation handoff, while a companion regression proves a stale concurrent loser cannot terminalize the winning handoff. Earlier custom-release completion, action-shadow, and replay-classification regressions likewise failed on preceding product heads and passed after their fixes.
- On product head `2951bcb435a578c4bfc35c4b9b62c4455857a052`, this trajectory ran the TypeScript SDK (22 files / 441 tests), types package (7 files / 209 tests), Rust SDK (103 tests plus 5 doc tests), and Rust library clippy. Those package code and test files are unchanged through final product head `0d91d76c180ee720120b58af5753e95f1868a71f`; later engine-only commits harden lifecycle routing and raise no SDK surface changes.

## Chapters

### 1. Work

*Agent: default*

- Exact token-hash guards fail closed at route, dispatch, socket-owner authorization, drain/retry, and atomic completion while legacy unguarded callers remain compatible; the dedicated agent lifecycle route cannot be shadowed by a registered action, and a custom action named `release` remains generic.
- Idempotent replays preserve the durable generation-conflict response, and an accepted socket send cannot fall through to local deletion when an older adapter rejects the proof or a completion wins before the dispatch stamp.
- Built-in lifecycle authority is recorded independently from the nullable action foreign key; provider capability refreshes may prune the referenced custom action without reclassifying its in-flight invocation.
- Retry, queued drain, and inventory reconciliation fail a pruned registered action as `action_deleted` instead of resolving its stale name to a replacement registration.
- A registered node-action retry transfers identity to a live same-name fallback with one source-generation CAS; deletion wins by clearing the source FK, while a concurrent successful handoff cannot be clobbered by a stale loser.
- Migration failure of ambiguous legacy invocations reconciles native spawn reservations before terminalizing the rows, so upgrades cannot strand finite node capacity.
- Migration-failed spawns reject late `agent.register` frames by exact invocation id or, for legacy workers without one, their persisted node/provider/name tuple; unrelated tuple registrations remain allowed.
- Nontransactional registration acquires its capacity slot before any durable identity write and compensates the exact generated agent plus its slot if a later membership or binding write fails.
- Local hostless release captures the current active binding inside the atomic completion and uses that durable node for response replay and `agent.exited`, even when a same-generation rebind wins after the initial host snapshot.
