# Changelog

All notable changes to `@relaycast/engine` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased - Minor]

### Added
- Added durable `agent.exited` events on every node-hosted agent exit (deregistration, missing from an inventory sync, and release), delivered to the durable workspace event log, webhook subscribers, and the spawn caller's mailbox, and carrying `agent_id`, `agent_name`, `node_id`, `invocation_id`, and a `reason`.
- Added durable `node.status.online` / `node.status.offline` events on node liveness transitions (offline carries a `reason` such as `liveness_timeout`, `disconnected`, or `deregistered`), delivered to the workspace event log and webhook subscribers.
- Message retention remains opt-in (`pruneExpired` still defaults `messageTtlDays` to `null`). Self-host can now opt in to a deployment-wide message TTL: `startServer` accepts `eventQueue` (`DurableEventQueueOptions`, including `retention`), and the `relaycast-engine` CLI exposes `RELAYCAST_MESSAGE_TTL_DAYS` (positive = prune after N days; unset or `0`/negative = keep forever).
- Exported the provider-attach arbitration policy from `@relaycast/engine/node-control`: `providerAttachDecision()` plus `PROVIDER_ATTACH_LIVENESS_MS`, so an out-of-process socket owner (a hosted NodeDO) mirrors the spec §3.1 decision from one source of truth instead of hand-copying the constant and logic.

### Fixed
- Provider-attach arbitration accepts an unbound provider regardless of a caller's last-seen timestamp instead of reporting a false live-instance conflict.
- Moved delivery TTL expiry out of inbox reads into bounded scheduled D1-safe batches, keeping reads available through cleanup failures without duplicating sender failure notices.

## [6.0.3] - 2026-07-12

### Fixed
- Kept per-agent delivery sequences monotonic across delivery pruning and message-retention cascades, including migration repair for active rows hidden behind an acknowledged cursor.
- Negotiated node brokers receive each resumed agent's authoritative delivery ACK cursor before replay or live delivery, with provider-scoped reconnect inventory and control frames that cannot disturb another provider's agents, cursors, or invocations.

## [6.0.2] - 2026-07-11

### Fixed
- Logged node teardown failures with provider and node context while preserving the original error stack.

## [6.0.1] - 2026-07-11

### Fixed
- Serialized provider attachment so concurrent registration cannot drop a provider's capabilities from the node aggregate.
- Rescheduling a node-scoped action onto a fallback node targets the provider that owns the action and honors that provider's liveness and queue policy. Previously a crash-recovery reschedule onto a multi-provider node could dispatch to the broker or queue behind an offline non-queued owner, leaving the invocation stuck.
- Message triggers fire node-scoped (fleet-provider) actions: a trigger bound to an action name now resolves plain node-scoped actions and dispatches them node-addressed, so `defineNode`'s onMessage→action handlers run. Previously the trigger's workspace-global resolver excluded node-scoped actions, so such triggers never fired.
- Provider-attach conflict honors spec §3.1: a restarted node instance (new `instance_id`) supersedes a stale binding instead of being rejected, while a genuinely live duplicate still rejects. The 35s attach window covers the built-in SDKs' 30s node heartbeat cadence with scheduling slack while remaining below the 45s node TTL.
- Self-host (file-backed SQLite): route every write through one async gate so a raw statement write can no longer busy-wait the event loop while a transaction holds the write lock. Under concurrent node registration, this deadlocked on `busy_timeout` and silently dropped a provider's capabilities from the node aggregate (#250).
- Node control logs a rejected `node.register`/`node.heartbeat` (e.g. `node_name_conflict`, a UNIQUE violation) at warn level with workspace/node/provider/code context, so a node left half-registered by a rejected message is no longer invisible server-side.
- Message-trigger dispatch failures are logged at warn with trigger/action/workspace context instead of being swallowed, so a trigger whose action is missing or unroutable is diagnosable.

## [6.0.0] - 2026-07-09

### Added
- Allowed multiple named providers to share a logical node while retaining provider-owned capabilities, actions, liveness, and routing policy.
- Added provider disconnect hooks and corrected aggregate node state after a provider disconnects.

## [5.1.1] - 2026-07-08

### Added
- Added Relayfile inbound integration ingress and delivery to node agents.

## [5.1.0] - 2026-07-02

### Added
- Added the durable workspace event log used by observer clients.

## [5.0.12] - 2026-07-02

### Fixed
- Recognized wrapped Cloudflare D1 unique-constraint errors so duplicate observer-token names return `409 observer_token_name_conflict` instead of `500`.

## [5.0.11] - 2026-07-01

### Fixed
- Allowed observer tokens to read workspace metadata.

## [5.0.10] - 2026-07-01

### Added
- Added optional egress proxying for `http_push` delivery.

## [5.0.9] - 2026-07-01

### Fixed
- Fixed `http_push` delivery on Cloudflare when `redirect: 'error'` rejects a dispatch.

## [5.0.8] - 2026-06-30

### Fixed
- Delivered ephemeral reactions, receipts, and presence events to `http_push` nodes.

## [5.0.7] - 2026-06-28

### Added
- Emitted `message.created` from inbound webhook triggers.

## [5.0.6] - 2026-06-27

### Added
- Preserved inbound webhook payloads in message metadata.

## [5.0.5] - 2026-06-26

### Added
- Exported node invocation helpers from the engine package.

## [5.0.4] - 2026-06-26

### Added
- Exported agent disconnect handling from the engine package.

## [5.0.3] - 2026-06-26

### Added
- Exported the node-control handler from the engine package.

## [5.0.2] - 2026-06-26

### Changed
- Routed agent fanout events through node streams.

## [5.0.1] - 2026-06-25

### Changed
- Made realtime delivery node-only.

## [5.0.0] - 2026-06-25

### Added
- Added first-class `direct_ws`, `fleet_ws`, and `http_push` node delivery contracts, agent bindings, HTTP authentication and acknowledgement modes, and retry state.

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
