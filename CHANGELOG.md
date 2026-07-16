# Changelog

Cross-package, user-facing release notes for Relaycast. The npm packages are
released in lockstep; package changelogs contain package-level API and migration
detail.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Package changelogs

- [`@relaycast/engine`](packages/engine/CHANGELOG.md)
- [`@relaycast/sdk` (TypeScript)](packages/sdk-typescript/CHANGELOG.md)
- [`@relaycast/types`](packages/types/CHANGELOG.md)
- [`relaycast` (Rust SDK)](packages/sdk-rust/CHANGELOG.md)
- [Relaycast Swift SDK](packages/sdk-swift/CHANGELOG.md)

Packages without a separate changelog are covered by the cross-package notes below.

## [Unreleased - Minor]

### Added

- Message retention remains opt-in (history is kept forever by default); self-host deployments can now opt in to a deployment-wide message TTL via `RELAYCAST_MESSAGE_TTL_DAYS`.

### Fixed

- Allowed Swift clients to decode hosted agent lifecycle statuses and complete realtime connections.
- Kept inbox and delivery reads independent from scheduled cleanup while large expired-delivery backlogs drain in bounded batches.
- Stopped a reconnecting node broker from silently dropping messages: a same-connection `node.register` re-register now preserves already-announced agents' delivery readiness, and readiness-gated skips stamp the delivery row for retry instead of dead-lettering it after the mailbox TTL.
- Recovered WebSocket node messages whose single live dispatch was lost or failed: the periodic delivery sweep now redrives queued ws-node rows (not just `http_push`), so they retry until the node reconnects instead of sitting queued until the mailbox TTL dead-letters them.

## [6.0.3] - 2026-07-12

### Fixed

- Preserved monotonic per-agent delivery sequences across retention and pruning.
- Negotiated authoritative delivery cursors when node brokers reconnect, preventing duplicate or missed replay.

## [6.0.2] - 2026-07-11

### Fixed

- Logged node teardown failures with their original stack instead of silently swallowing them.

## [6.0.1] - 2026-07-11

### Fixed

- Prevented provider-attach races from dropping node capabilities.
- Serialized self-hosted SQLite writes to avoid transaction deadlocks.
- Logged rejected node-control messages and message-trigger dispatch failures.
- Allowed restarted providers to replace stale bindings while rejecting live duplicates.
- Dispatched node-scoped message-trigger actions to the owning provider.
- Rescheduled node-scoped actions according to the owning provider's liveness and queue policy.

## [6.0.0] - 2026-07-09

### Added

- Allowed one logical node to host multiple named providers with provider-owned capabilities and node-scoped actions.
- Added node provider clients for the TypeScript, Python, and Swift SDKs.
- Added provider disconnect hooks and aggregate node-state cleanup in the engine.

### Fixed

- Minted scoped observer tokens for realtime streams.

## [5.1.1] - 2026-07-08

### Added

- Added Relayfile inbound integration ingress and delivery to node agents.

## [5.1.0] - 2026-07-02

### Added

- Added a durable workspace event log for the observer plane.

## [5.0.12] - 2026-07-02

### Fixed

- Correctly recognized D1 observer-token name conflicts as conflicts instead of internal errors.

## [5.0.11] - 2026-07-01

### Added

- Added action events, a persisted observer feed, and improved observer navigation.

### Fixed

- Accepted `ot_live_` observer tokens at dashboard login.
- Allowed observer tokens to read workspace metadata.

## [5.0.10] - 2026-07-01

### Added

- Added optional egress proxying for `http_push` delivery.

## [5.0.9] - 2026-07-01

### Fixed

- Fixed `http_push` webhook dispatch on Cloudflare when redirects are rejected.

## [5.0.8] - 2026-06-30

### Fixed

- Delivered ephemeral reactions, receipts, and presence events to `http_push` nodes.

## [5.0.7] - 2026-06-28

### Added

- Emitted `message.created` for inbound webhook triggers.

### Fixed

- Prevented stale TypeScript SDK build output from being published.

## [5.0.6] - 2026-06-27

### Added

- Preserved inbound webhook payloads in message metadata.

## [5.0.5] - 2026-06-26

### Added

- Exported node invocation helpers from the engine.

## [5.0.4] - 2026-06-26

### Added

- Added Python SDK parity for node events.
- Exported agent disconnect handling from the engine.

## [5.0.3] - 2026-06-26

### Added

- Exported the engine's node-control handler.

## [5.0.2] - 2026-06-26

### Changed

- Routed agent fanout events through node streams.

## [5.0.1] - 2026-06-25

### Changed

- Made realtime delivery node-only.

## [5.0.0] - 2026-06-25

### Breaking

- Made the engine cast-only; SDK clients now own base URL defaults.

### Added

- Made nodes first-class delivery hosts for agents across direct WebSocket, fleet WebSocket, and HTTP-push transports.
- Added agent-to-node bindings, HTTP-push authentication and acknowledgement modes, delivery retries, and redacted node configuration.
- Added matching node delivery contracts to the TypeScript, Python, Rust, and Swift SDKs.

Earlier releases are available on the [GitHub releases page](https://github.com/AgentWorkforce/relaycast/releases).

[Unreleased - Patch]: https://github.com/AgentWorkforce/relaycast/compare/v6.0.3...HEAD
[6.0.3]: https://github.com/AgentWorkforce/relaycast/compare/v6.0.2...v6.0.3
[6.0.2]: https://github.com/AgentWorkforce/relaycast/compare/v6.0.1...v6.0.2
[6.0.1]: https://github.com/AgentWorkforce/relaycast/compare/v6.0.0...v6.0.1
[6.0.0]: https://github.com/AgentWorkforce/relaycast/compare/v5.1.1...v6.0.0
[5.1.1]: https://github.com/AgentWorkforce/relaycast/compare/v5.1.0...v5.1.1
[5.1.0]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.12...v5.1.0
[5.0.12]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.11...v5.0.12
[5.0.11]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.10...v5.0.11
[5.0.10]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.9...v5.0.10
[5.0.9]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.8...v5.0.9
[5.0.8]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.7...v5.0.8
[5.0.7]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.6...v5.0.7
[5.0.6]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.5...v5.0.6
[5.0.5]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.4...v5.0.5
[5.0.4]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.3...v5.0.4
[5.0.3]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.2...v5.0.3
[5.0.2]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.1...v5.0.2
[5.0.1]: https://github.com/AgentWorkforce/relaycast/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/AgentWorkforce/relaycast/compare/v4.2.0...v5.0.0
