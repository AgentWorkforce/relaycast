# Trajectory: Make Relaycast release cleanup generation-safe

> **Status:** ✅ Completed
> **Task:** Relay #1672
> **Confidence:** 90%
> **Started:** September 6, 2026 at 08:36 AM
> **Completed:** September 6, 2026 at 09:01 AM

---

## Summary

Added SHA-256 token-generation guarded releases across Relaycast types, engine, OpenAPI, TypeScript SDK, and Rust SDK, with takeover, drain, replay, and completion-race regressions plus atomic dispatch/completion enforcement.

**Product commits:** `2951bcb435a578c4bfc35c4b9b62c4455857a052`, `fd4208e84a45661a4dd58468e918ef879e2c57dc`, `99c31ea9d4b9298e43d6da0b726f1a20119467a8`, `0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`

**Attribution range:** `80ab366048a0634fbf1a8b5301de71dd22c50026..0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`

**Changed product files:** `CHANGELOG.md`, `README.md`, `openapi.yaml`, four package changelogs, the engine route/action/realtime contract and Node adapter, three engine conformance suites, TypeScript SDK tests, and Rust SDK implementation/parity tests. The exact list is recorded in `trajectory.json`.

**Approach:** Standard approach

---

## Key Decisions

### Use a SHA-256 token-generation verifier for release compare-and-swap

- **Chose:** Use a SHA-256 token-generation verifier for release compare-and-swap
- **Reasoning:** Relaycast takeover deliberately preserves the agent ID while rotating the credential, so the ID cannot distinguish process generations. Persisting and comparing only the token hash binds cleanup to the exact issued generation without storing or transmitting the raw token.

---

## Verification provenance

- On exact product head `0b8c5cc44acef0fbde5e88c6e35d2b5c20dddec0`, this trajectory reran engine lint, engine typecheck, focused release/provider regressions (52 tests), and the full engine suite (70 files / 759 tests).
- On product head `2951bcb435a578c4bfc35c4b9b62c4455857a052`, this trajectory ran the TypeScript SDK (22 files / 441 tests), types package (7 files / 209 tests), Rust SDK (103 tests plus 5 doc tests), and Rust library clippy. Those package sources were unchanged by the three later engine-only product commits.

## Chapters

### 1. Work

*Agent: default*

- Exact token-hash guards fail closed at route, dispatch, socket-owner authorization, drain/retry, and atomic completion while legacy unguarded callers remain compatible.
- Idempotent replays preserve the durable generation-conflict response, and an accepted socket send cannot fall through to local deletion when an older adapter rejects the proof or a completion wins before the dispatch stamp.
