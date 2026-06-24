# Changelog

All notable changes to `@relaycast/engine` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Refactored route handlers, route response helpers, and service internals without changing the public HTTP envelopes or API behavior.
- Split engine internals into focused modules for background jobs, migrations, node adapters, websocket handling, and shared route utilities.

## [4.2.0] - 2026-06-23

### Changed
- Consolidated route response helpers so handlers consistently emit `{ ok: true, data: ... }` and `{ ok: false, error: ... }` envelopes.
- Added focused coverage for response helper behavior across engine HTTP routes.

## [4.1.6] - 2026-06-21

### Changed
- Version alignment release; no engine-specific runtime changes.

## [4.1.5] - 2026-06-20

### Added
- Allowed `grok` in the agent spawn CLI allowlist.

## [4.1.4] - 2026-06-19

### Fixed
- Returned `workspace_id` from agent registration responses for SDK parity.

## [4.1.2] - 2026-06-19

### Changed
- Consolidated duplicated error, serialization, and attachment helpers used by engine routes.

## [4.1.1] - 2026-06-18

### Changed
- Version alignment release; no engine-specific runtime changes.

## [4.1.0] - 2026-06-18

### Added
- Accepted node roster snapshots in `node.heartbeat` frames.

## [4.0.0] - 2026-06-15

### Breaking
- Reworked durable delivery status semantics for fleet location routing: `accepted` and `deferred` are no longer emitted, `queued`, `acked`, and `dead_lettered` model the lifecycle, and `delivered` now means sent to the current location while awaiting ack.
- Added a migration path that rewrites existing durable delivery rows to the new fleet mailbox status model.

### Added
- Fleet node registry, node-native actions, placement, triggers, and node control channel support.
- Bounded durable mailbox with fleet location routing, per-workspace rollout controls, and single-delivery migration safeguards.
- Retention pruning with per-workspace TTLs and webhook outbox follow-ups.

### Changed
- Removed `origin_surface` from the telemetry origin contract.

### Fixed
- Restored Node websocket build compatibility after the telemetry origin contract change.

## [3.1.1] - 2026-06-11

### Changed
- Version alignment release; no engine-specific runtime changes.

## [3.1.0] - 2026-06-10

### Changed
- Version alignment release; no engine-specific runtime changes.

## [3.0.0] - 2026-06-10

### Added
- Atomic multi-statement write paths and write batches for hosted and D1-backed adapters.
- Durable webhook outbox support for the Node adapter and persist-first queue-backed adapters.
- Spawn request `model` propagation through to spawn events.

### Changed
- Renamed telemetry attribution from `harness` to `origin_actor`.

## [2.5.1] - 2026-06-03

### Fixed
- Sent telemetry through the hosted ingestion proxy.

## [2.5.0] - 2026-06-03

### Changed
- Made telemetry a no-op when no key is configured.
- Accepted and forwarded the Agent Relay distinct identity for telemetry attribution.

## [2.4.0] - 2026-06-03

### Added
- End-to-end harness attribution using the SDK sender and the server-side User-Agent-style contract.

## [2.3.0] - 2026-06-03

### Changed
- Aligned the engine service contract with SDK v8 expectations.

### Fixed
- Prevented metadata author spoofing.
- Removed an unreachable action-denied branch.

## [2.2.0] - 2026-06-02

### Added
- Durable delivery inbox APIs for listing, acking, failing, and deferring deliveries.

### Fixed
- Made delivery transitions concurrency-safe and idempotent without duplicate events.
- Normalized legacy `pending` deliveries and corrected deferred, recoverable-failure, and terminal-delivered edge cases.
- Returned `400` for malformed JSON in the delivery fail endpoint.

## [2.1.0] - 2026-06-01

### Changed
- Version alignment release; no engine-specific runtime changes after the initial tracked package baseline.

## [1.1.7] - 2026-06-01

### Added
- Initial portable `@relaycast/engine` package with an independent publish flow.
- Node and SQLite self-host adapter plus portable ports for auth, database, files, KV, presence, rate limiting, realtime, and telemetry.
- Core engine and route modules for workspaces, channels, threads, messages, DMs, group DMs, reactions, receipts, search, files, agents, A2A, actions, directories, webhooks, routing, console, system prompts, and resync.
- Database migrations and conformance tests for portable engine behavior.

### Changed
- Tightened types and validation to reduce cast-based implementation debt.
- Replaced Node `crypto` usage with Web Crypto for portability.

### Fixed
- Reused soft-removed A2A proxy agents on re-registration.
- Hardened security, correctness, and robustness issues found during review.
- Used a conservative rate-limit fallback when entitlement checks fail.
- Removed the bundled MCP implementation from the engine package.
