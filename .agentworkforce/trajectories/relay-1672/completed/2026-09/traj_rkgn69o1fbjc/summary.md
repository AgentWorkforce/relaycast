# Trajectory: Make Relaycast release cleanup generation-safe

> **Status:** ✅ Completed
> **Task:** Relay #1672
> **Confidence:** 90%
> **Started:** September 6, 2026 at 08:36 AM
> **Completed:** September 6, 2026 at 12:44 PM

---

## Summary

Added SHA-256 token-generation guarded releases across Relaycast types, engine, OpenAPI, TypeScript SDK, and Rust SDK, with takeover, drain, retry, reconciliation, replay, completion-race, action-shadow, custom-action isolation, migration-capacity, reservation-ownership, concurrent-rebind, and concurrent action-prune regressions plus atomic dispatch/completion enforcement. Invocation origin is immutable across registered-action pruning, and agent- or node-hosted dispatch commits the exact action, route, and accepted attempt at the socket owner so retry and timeout recovery cannot duplicate, retarget, or revoke accepted work. Migration-failed spawns remain durable cancellation tombstones: explicit ids are bound to their node/provider/name tuple, and an ID-less worker fails closed when a same-tuple tombstone makes it indistinguishable from the stale process. Nontransactional registration acquires capacity before writes with exact-identity compensation for later failure while preserving duplicate-identity error precedence.

**Product commits:** `2951bcb435a578c4bfc35c4b9b62c4455857a052`, `fd4208e84a45661a4dd58468e918ef879e2c57dc`, `99c31ea9d4b9298e43d6da0b726f1a20119467a8`, `0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`, `038af6af9ad61e53e08790fb5ffa3051f3017951`, `90b9711882460236c52a3a03f4025bf5361b8eeb`, `cd935897bd3ea9de39f98844c5e7e768653cc84e`, `7e91c060bce63dd6340977c548f7ee3fc4f071d4`, `e0f7757c17e4f9d85b079190e8734c6d5846430c`, `da79986f776393aa491a85450b2474d2c0b2bdc5`, `2e61bfccdb0247a58f8a6bf8742d59162580a1ab`, `64b199b0e2cf72fc913a1882e1771bb67dd92420`, `f6a219f0ebc3f6db6a3a517588802f4316c774cd`, `4e85e36a62577e1ae8e14ecb2401bcf16002a0c1`, `984c575d11cf25fc16f19182065a671834b6030c`, `91c791f86a7db00ed29be61a42f9ab931e890c49`, `0d91d76c180ee720120b58af5753e95f1868a71f`, `ffb225fc1b836e57d24004e83055bcf064d37a20`, `3a3d17733494f4c00573b5496a1653f80e4585c5`, `acf543c95d8a69f881d8fd160248ca38593719cb`, `63c1f730d6d2e235c8cfb2792ba808d31fc643f0`, `1c0bfb2e0552bf387c644e6eae8367448d82fb93`, `f5b61e5f3f3bedad435fe9ce7ac314b020d484bb`, `1850bcec9e364d346e7195f40614f95611077fad`

**Attribution range:** `8e36b742ced89d5e2d4be0866a7f641b31e0acfb..1850bcec9e364d346e7195f40614f95611077fad`

**Changed product files:** `CHANGELOG.md`, `README.md`, `openapi.yaml`, four package changelogs, the engine route/action/realtime contract, schema and migration, Node adapter, five engine conformance suites and migration tests, TypeScript SDK tests, and Rust SDK implementation/parity tests. The exact list is recorded in `trajectory.json`.

**Approach:** Standard approach

---

## Key Decisions

### Use a SHA-256 token-generation verifier for release compare-and-swap

- **Chose:** Use a SHA-256 token-generation verifier for release compare-and-swap
- **Reasoning:** Relaycast takeover deliberately preserves the agent ID while rotating the credential, so the ID cannot distinguish process generations. Persisting and comparing only the token hash binds cleanup to the exact issued generation without storing or transmitting the raw token.

### Bind released spawn capacity to durable cancellation and exact reservation ownership

- **Chose:** Bind released spawn capacity to durable cancellation and exact reservation ownership
- **Reasoning:** Migration must free otherwise permanent capacity without admitting a worker from an already-terminalized frame. The failed invocation id and node/provider/name tuple form an immutable cancellation tombstone. When an ID-less registration collides with that tuple, even a newer reservation cannot prove which worker is registering, so only the replacement's exact invocation id can authorize it.

---

## Verification provenance

- On exact product head `1850bcec9e364d346e7195f40614f95611077fad`, this trajectory reran focused engine regressions (4 files / 109 tests), root lint (13/13), root test (18/18, including the full engine suite: 70 files / 792 tests), and root build (9/9) after restacking once on current main. Six behaviors were reproduced on test-only head `2f6a6afabf2864b4d27283f5e0fb41737aed3656`: agent-hosted acceptance lacked a durable route and generation before send; migration 0047 left historical accepted registered actions unmarked; an explicit tombstone matched only invocation id rather than its node/provider/name tuple; registered node-action acceptance trusted a mutable dispatched capability rather than the invocation action; timeout recovery cleared an accepted pruned route; and an ID-less stale worker could consume a same-tuple replacement reservation. Two further must-fire P1 regressions failed on exact test-only head `bbbe944616c5c35142af8c457c94309488d97fd6`: a canceled legacy spawn with intentionally unknown provider ownership admitted its worker, and an authorization captured for an older dispatch attempt sent after the invocation returned to the identical action/node/provider tuple. A rolling-upgrade regression failed on exact test-only head `c797a18fe90081ebc06930af8ad9ac0751dcbd46`: the stricter attempt proof still used v1, so a legacy owner accepted it without understanding the generation. These pass through exact previously-unaccepted attempt CAS, conservative unknown-provider tombstone matching, a versioned v2 proof, and explicit v1 rejection by current owners. Earlier red regressions prove guarded release dispatch and completion, replay durability, retry/drain/reconciliation behavior, registration rollback, migration capacity accounting, exact action-generation handoff, and stale concurrent loser isolation.
- On product head `2951bcb435a578c4bfc35c4b9b62c4455857a052`, this trajectory ran the TypeScript SDK (22 files / 441 tests), types package (7 files / 209 tests), Rust SDK (103 tests plus 5 doc tests), and Rust library clippy. Those package code and test files are unchanged through exact product head `1850bcec9e364d346e7195f40614f95611077fad`; later engine-only commits harden lifecycle routing and raise no SDK surface changes.

## Chapters

### 1. Work

*Agent: default*

- Exact token-hash guards fail closed at route, dispatch, socket-owner authorization, drain/retry, and atomic completion while legacy unguarded callers remain compatible; the dedicated agent lifecycle route cannot be shadowed by a registered action, and a custom action named `release` remains generic.
- Idempotent replays preserve the durable generation-conflict response, and an accepted socket send cannot fall through to local deletion when an older adapter rejects the proof or a completion wins before the dispatch stamp.
- Built-in lifecycle authority is recorded independently from the nullable action foreign key; provider capability refreshes may prune the referenced custom action without reclassifying its in-flight invocation.
- Retry, queued drain, and inventory reconciliation fail a pruned registered action as `action_deleted` instead of resolving its stale name to a replacement registration.
- Registered node-action dispatch transfers identity to a live same-name fallback while atomically claiming its route and attempt; the socket owner revalidates that exact action before send, a second retry cannot duplicate the frame, stale failure cannot clobber a newer attempt, and pruning after provider acceptance leaves route-owned completion intact.
- Native spawn validates a non-empty, registrable agent name before creating its invocation or reserving capacity.
- Migration failure of ambiguous legacy invocations reconciles native spawn reservations before terminalizing the rows, so upgrades cannot strand finite node capacity.
- Migration-failed spawns reject late `agent.register` frames by exact invocation id or, for legacy workers without one, their persisted node/provider/name tuple; unrelated tuple registrations remain allowed.
- Nontransactional registration acquires its capacity slot before any durable identity write and compensates the exact generated agent plus its slot if a later membership or binding write fails.
- Local hostless release captures the current active binding inside the atomic completion and uses that durable node for response replay and `agent.exited`, even when a same-generation rebind wins after the initial host snapshot.
