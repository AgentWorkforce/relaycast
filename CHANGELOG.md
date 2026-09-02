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

## [Unreleased - Patch]

### Fixed

- Invoking an agent-handled action whose host cannot deliver to the handler now fails with 503 `handler_unavailable` instead of 503 `idempotency_unavailable`.

## [8.3.0] - 2026-09-02

### Added

- `@relaycast/types` declares which node frame carries each event type (`NODE_DELIVER_FRAME_EVENT_TYPES`, `nodeFrameKindFor`), so hosts can tell `deliver`-frame events from `context.update` events without copying the engine's list.

## [8.2.2] - 2026-09-02

### Fixed

- Never-dispatched pending action invocations are now bounded by absolute age (default 72h), so stale spawn queues can no longer drain into live agents that evict an existing resident under the same name.
- Retried action invocations reuse the original invocation instead of executing a provider action twice, wait for a durable dispatch outcome, and preserve locally completed release routing identity.

## [8.2.1] - 2026-08-24

### Fixed

- Fleet heartbeats and agent reads no longer amplify into workspace-wide D1 maintenance scans; pending delivery views also exclude expired rows before cleanup runs.

## [8.2.0] - 2026-08-21

### Added

- Workspace creation records provenance and explicit internal/external/unknown classification for hosted per-workspace usage reporting without adding message-path writes.

### Security

- Observer tokens receive workspace provenance without request actor, user, machine, or organization identity fields.

## [8.1.3] - 2026-08-20

### Fixed

- Fleet reconnect drains and activity-feed reads no longer perform repeated full-table D1 scans as invocation and DM history grows.

## [8.1.2] - 2026-08-19

### Fixed

- The activity feed now uses the indexed monotonic message order instead of scanning and sorting an entire workspace history.

## [8.1.1] - 2026-08-19

### Fixed

- Scheduled delivery expiry now drains up to 2,500 rows per invocation in bounded D1-safe batches, preventing expired mailbox rows from accumulating faster than the sweep can clear them.

## [8.1.0] - 2026-08-19

### Added

- Fleet nodes can advertise placement-safe `owner/name` repository keys without exposing local checkout paths.

### Security

- A node can no longer smuggle a repository advertisement through its `tags` list. When `node.register` carries `repo_keys` — including as an empty array — that field is the only source of the `repo:<owner/name>` tags placement matches on, and any `repo:` tag supplied in `tags` is dropped. Register messages that omit `repo_keys` stay on the pre-`repo_keys` tag-only path.

## [8.0.7] - 2026-08-19

### Added

- Replay clients can resolve indexed `session_ref` message slices with a live per-workspace retention boundary and fail-closed retained, partial, aged-out, or unknown availability.

### Fixed

- Channel, thread, and group-DM clients now forward replay metadata, and group-DM redelivery preserves it across broker reconnects.

## [8.0.6] - 2026-08-18

### Added

- Workspaces can opt into an explicit expiry at creation or be deleted immediately with their own key, including durable event rows and retryable post-commit cleanup of stored file bytes.

## [8.0.5] - 2026-08-18

### Fixed

- Workspace creation now requires atomic storage for the workspace and default
  channel, and exhausted storage failures no longer expose database internals.

## [8.0.4] - 2026-08-17

### Fixed

- Keep prior agent token authenticatable during rotate-token grace

## [8.0.3] - 2026-08-15

### Fixed

- Removing an agent that has authored messages now succeeds. The agent row is
  retained so its messages keep their author, while the name is freed for reuse
  and the old credential stops authenticating.
- A removed or released agent is no longer a delivery target: its channel and
  direct-message memberships are cleared with it.
- A released agent can no longer be revived to `active` by a late heartbeat, and
  id-scoped updates no longer resolve to a released row.

## [8.0.2] - 2026-08-15

### Fixed

- Tombstone on node-completed release instead of deleting

## [8.0.1] - 2026-08-14

### Changed

- The self-host container now installs `@relaycast/engine` 8.0.0, matching the hosted deployment, and its runbook documents agent-card discovery as working on the standard well-known path rather than as a known defect.

### Fixed

- DM conversation and inbox reads remain available beyond 100 conversations, and the advertised DM-list limit now reaches the server instead of being ignored.

### Security

- Legacy agent identity claims are atomic, and generic agent updates cannot write the reserved `identity_key` metadata field.

## [8.0.0] - 2026-08-10

### Added

- Added a pinned, multi-architecture self-host container and Compose runbook with persistent SQLite/files state, health checks, and mandatory HTTPS deployment-authority validation.
- A2A federation now preserves structured DM metadata end to end, defines a versioned `com.agentrelay.ratify` carrier for proof bundles and signed revocation lists, and supports reciprocal authenticated delivery between registered peers.

### Fixed

- A2A counterparties can discover a self-hosted deployment at the standard `GET /.well-known/agent-card.json`, and `/:workspace/.well-known/agent-card.json` now resolves. Deployments holding more than one workspace still require a selector.

## [7.0.0] - 2026-08-07

### Fixed

- Fleet node rosters now return `load: null` until a direct node, or every constituent provider of a broker node, explicitly reports a genuine normalized capacity-utilization measurement.
- Fleet capacity now treats `max_agents: 0` consistently as unlimited.

## [6.3.2] - 2026-08-02

### Fixed

- 1:1 DM resolution now atomically reserves each deterministic conversation ID for its workspace and participant pair. A collision returns `409 dm_conversation_id_collision` instead of silently aliasing another conversation.

## [6.3.1] - 2026-07-31

### Fixed

- Sending into a 1:1 DM whose participant is marked as departed now restores that participant, instead of resolving the conversation while its roster still shows the departure.

## [6.3.0] - 2026-07-28

### Added

- Callers can attribute requests to a machine, user, and organization via `X-Agent-Relay-Machine-Id` / `-User-Id` / `-Org-Id` / `-Org-Slug` headers (or `agent_relay_*` query params on WebSocket upgrades), so hosted usage is reported per person and per customer rather than only per workspace. Analytics only — never affects authorization. See the README's Telemetry Attribution section.

### Fixed

- Corrected the canonical `deliver` wire fixture in `@relaycast/types` to the `{type, data}` payload the engine actually emits, so SDK authors are not coding against a stale flat shape.
- SDK telemetry identity now reaches WebSocket connections, both the workspace observer stream and agent sockets. `ws_session_started` was previously anonymous for identified callers.

## [6.2.0] - 2026-07-17

### Added

- Durable `agent.exited` event when a node-hosted agent leaves (deregister, missing from an inventory sync, or release), carrying `agent_id`, `agent_name`, `node_id`, the spawn `invocation_id`, and a `reason`; the spawn's caller is notified directly.
- Durable `node.status.online` / `node.status.offline` events on node liveness transitions (offline carries a `reason` like `liveness_timeout`). Wildcard webhook subscriptions (`events: ["*"]`) receive all three new events automatically.
- `POST /v1/agents/disconnect` accepts an optional `deregister` flag; SDK `disconnect()` and `presence.markOffline()` take `{ deregister?: boolean }` to opt into full node teardown.

### Changed

- Agent disconnect is presence-only by default for node-hosted agents: the node binding is kept so a still-running session keeps receiving deliveries, instead of silently re-homing to an offline direct node.

### Fixed

- Node enrollment (`POST /v1/nodes`) now keys on `node_id` when supplied: re-enrolling rotates (and can rename) the same node in place, and a name held by a different node is rejected with `node_name_conflict` (409) instead of silently rewriting the other node.
- Stopped a same-connection node broker `node.register` re-register from silently gating deliveries: already-announced agents keep their delivery readiness, and readiness-gated skips stamp the delivery row with observable retry metadata instead of failing silently.
- Recovered WebSocket node messages whose single live dispatch was lost or failed: instead of letting rows sit queued until the mailbox TTL dead-letters them, the periodic delivery sweep now redrives queued ws-node rows (not just `http_push`), replaying each agent's backlog in ascending order so a later message never outruns an earlier one.
- `POST /v1/actions` now treats re-registering an existing action name as an idempotent refresh (200) of its description, handler, schemas, `available_to`, and `is_active` instead of failing with a 500 unique-constraint error.
- Invoking an agent-handled action whose handler has no live connection fails fast with `handler_unavailable` (503), and invocations whose handler stays continuously unreachable past a bounded TTL are failed with an `action.failed` event instead of staying `pending` forever (a brief handler restart never kills an in-flight invocation).
- The TypeScript SDK no longer rewrites keys inside user-authored JSON: action `input_schema`/`output_schema`, invocation `input`/`output`, and `headers` maps now cross the wire verbatim in both directions.

## [6.1.0] - 2026-07-16

### Added

- Message retention remains opt-in (history is kept forever by default); self-host deployments can now opt in to a deployment-wide message TTL via `RELAYCAST_MESSAGE_TTL_DAYS`.

### Fixed

- Messages posted through an inbound webhook now fire channel message triggers, with the webhook's caller name preserved on the resulting action invocation.
- Allowed Swift clients to decode hosted agent lifecycle statuses and complete realtime connections.

## [6.0.5] - 2026-07-13

### Added

- Exported the provider-attach arbitration policy (`providerAttachDecision`, `PROVIDER_ATTACH_LIVENESS_MS`) from `@relaycast/engine/node-control` so out-of-process socket owners share the engine's attach-conflict decision instead of copying it.

### Fixed

- Provider attach accepts an unbound provider instead of reporting a false live-instance conflict.

## [6.0.4] - 2026-07-13

### Fixed

- Kept inbox and delivery reads independent from scheduled cleanup while large expired-delivery backlogs drain in bounded batches.

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

[Unreleased - Patch]: https://github.com/AgentWorkforce/relaycast/compare/v8.3.0...HEAD
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
