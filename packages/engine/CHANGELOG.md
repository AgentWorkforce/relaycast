# Changelog

All notable changes to `@relaycast/engine` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased - Patch]

### Fixed

- Invoking an agent-handled action whose host cannot deliver to the handler now fails with 503 `handler_unavailable` instead of 503 `idempotency_unavailable`.

## [8.2.2] - 2026-09-02

### Fixed

- `sweepTimedOutInvocations` now fails `pending` invocations that never dispatched (`dispatch_attempts = 0`) and are older than `PENDING_INVOCATION_MAX_AGE_MS` (default 72h) with the distinguishing error `never_dispatched_expired`. The existing `handler_unavailable` TTL guard, which requires a dispatched handler connection to observe unreachable, still runs first; the age bound covers the never-dispatched shape it cannot see.
- `POST /v1/actions/:name/invoke` atomically claims caller-scoped idempotency keys before provider dispatch, waits for a durable dispatch outcome, and replays the original invocation with its immutable handler and node identity, including locally completed releases.

## [8.2.1] - 2026-08-24

### Fixed

- Steady node heartbeats no longer re-scan pending workspace invocations; drains now run when reconnect, handler-liveness, or capacity transitions make queued work dispatchable.
- Agent reads derive presence without issuing cleanup writes, and migration `0042_d1_read_path_indexes.sql` indexes scheduled presence cleanup plus active, unexpired delivery reads.

## [8.2.0] - 2026-08-21

### Added

- Migration `0039` records workspace creation provenance and usage classification; workspace-key metadata returns the complete attribution record while observer tokens receive identity-redacted provenance.

## [8.1.3] - 2026-08-20

### Fixed

- Migration `0041_d1_hot_path_indexes.sql` adds a partial pending-invocation workspace index for node drains and a DM-channel lookup index for activity feeds, eliminating two production D1 scan hot paths.

## [8.1.2] - 2026-08-19

### Fixed

- Activity-feed reads use `idx_messages_workspace` for newest-first results instead of sorting every message in the workspace.

## [8.1.1] - 2026-08-19

### Fixed

- The scheduled expiry sweep drains up to fifty 50-row batches per invocation and batches failure fanout; migration `0040_delivery_retry_due_index.sql` adds the global partial retry index and should be applied after the expired backlog has drained.

## [8.1.0] - 2026-08-19

### Added

- Fleet registration persists placement-safe repository keys as public node tags for placement readback.

### Security

- Registration derives `repo:` node tags only from `repo_keys` whenever that field is present. A registration carrying it, including as an empty list, drops every `repo:` tag supplied in `tags`, so a node cannot advertise a repository through a tag it made up. Non-`repo:` tags still round-trip, and registrations that omit `repo_keys` keep the pre-`repo_keys` tag-only behavior.

## [8.0.7] - 2026-08-19

### Added

- Migration `0038` adds indexed `session_ref` message lookup and a payload-free session ledger; the API reports bounded replay slices and the live effective message-retention boundary without guessing when availability is unknown.

## [8.0.6] - 2026-08-18

### Added

- Migration `0036` adds indexed workspace expiry. The engine adds bounded automatic reaping and authenticated `DELETE /v1/workspaces/:id`, with complete database and blob-storage deletion.
- Migration `0037` adds upload-capability expiry metadata and a durable file-cleanup outbox. Workspace deletion commits its cleanup tombstones atomically with the database cascade, retries storage failures after commit, and retains each tombstone long enough to remove a late presigned upload.

### Changed

- `FileStorage` has an optional idempotent batch object-deletion capability; lifecycle deletion returns 503 before database changes when an adapter does not provide it. Queue/cron-backed hosts can use the exported `drainFileCleanup` helper directly; `reapExpiredWorkspaces` and the Node adapter also drain it automatically.

## [8.0.5] - 2026-08-18

### Fixed

- Workspace creation now requires atomic storage for the workspace and default
  channel, and classifies exhausted transient writes with a safe storage error.
- Uncoded server errors no longer expose SQL statements or bound parameters in
  API responses.

## [8.0.3] - 2026-08-15

### Fixed

- Removing an agent that has authored messages now succeeds. The agent row is
  retained so its messages keep their author, while the name is freed for reuse
  and the old credential stops authenticating.
- A removed or released agent is no longer a delivery target: its channel and
  direct-message memberships are cleared with it.
- A released agent can no longer be revived to `active` by a late heartbeat, and
  id-scoped updates no longer resolve to a released row.

## [8.0.1] - 2026-08-14

### Fixed

- DM conversation and unread-inbox enrichment batches large identifier sets below D1's bound-parameter ceiling, so long-lived agents no longer lose both read paths after accumulating more than 100 conversations.

### Security

- `PATCH /v1/agents/:name/legacy-identity` atomically claims an offline legacy agent's identity, while generic agent updates cannot overwrite the verifier.

## [8.0.0] - 2026-08-10

### Added

- A2A registration accepts a remote `target_agent`; a connection update endpoint completes reciprocal credentials, and registered peer tokens can deliver versioned message metadata to local DMs with normal realtime delivery.

### Fixed

- Agent-card discovery resolves the workspace from an explicit `/:workspace/` path segment before host-label inference, and serves the sole workspace when a deployment has exactly one and no selector was given. Deployments with more than one workspace, and unresolved explicit selectors, return `workspace_not_found`.

## [7.0.0] - 2026-08-07

### Fixed

- Node heartbeats now accept absent/null `load` and require `load_reported` before trusting a numeric measurement.
- Migration `0034` leaves historical placeholder load values unreported.
- `GET /v1/nodes` now returns null load until a direct node, or every constituent provider of a broker node, reports a genuine measurement.
- Future-dated heartbeats no longer count as fresh.
- Broker capacity remains unlimited when any constituent provider is unbounded.

## [6.3.2] - 2026-08-02

### Fixed

- `sendDm` atomically reserves each deterministic 1:1 conversation ID for its workspace and sorted participant pair, so a collision returns `409 dm_conversation_id_collision` on every driver instead of resolving to another pair's conversation or failing with an uncaught database error. Migration `0033` adds `dm_conversation_reservations` and backfills existing 1:1 DMs; see the migration header for the pre-flight audit to run before applying it.

## [6.3.1] - 2026-07-31

### Fixed

- `sendDm` re-resolving a 1:1 conversation now clears `dm_participants.left_at` for both participants instead of no-opping on conflict. A 1:1 with a departed participant previously resolved to the same conversation while its roster still showed the departure; the conversation id is unchanged either way, since it derives only from the workspace and the sorted agent pair.

## [6.3.0] - 2026-07-28

### Added
- `extractActorIdentity(request)` reads caller-declared identity from the `X-Agent-Relay-Machine-Id` / `-User-Id` / `-Org-Id` / `-Org-Slug` headers, falling back to the matching `agent_relay_*` query params for WebSocket upgrades. Malformed or oversized values are dropped rather than truncated.
- Server events carry `actor_machine_id` / `actor_user_id` / `actor_org_id` / `actor_org_slug` and `is_authenticated`, and key on the caller's user id when present (`actor_user_id ?? client_distinct_id ?? workspace_id`). Analytics dimensions only; they never affect authorization.

## [6.2.0] - 2026-07-17

### Added
- Added durable `agent.exited` events on every node-hosted agent exit (deregistration, missing from an inventory sync, and release), delivered to the durable workspace event log, webhook subscribers, and the spawn caller's mailbox, and carrying `agent_id`, `agent_name`, `node_id`, `invocation_id`, and a `reason`.
- Added durable `node.status.online` / `node.status.offline` events on node liveness transitions (offline carries a `reason` such as `liveness_timeout`, `disconnected`, or `deregistered`), delivered to the workspace event log and webhook subscribers.
- `handleAgentDisconnect` accepts an optional `{ deregister?: boolean }` argument, and `POST /v1/agents/disconnect` accepts an optional `{ deregister?: boolean }` body.
- `sweepTimedOutInvocations` accepts `handlerUnreachableTtlMs`/`completionDeps` and `@relaycast/engine/node-invocations` exports `ACTION_HANDLER_UNREACHABLE_TTL_MS`: an agent-handled invocation whose handler stays continuously unreachable for the TTL is failed with `handler_unavailable` and the caller receives `action.failed`. Migration `0032` adds `action_invocations.handler_unreachable_since` (the grace clock resets on recovery, so a brief handler restart never kills an in-flight invocation).

### Changed
- `handleAgentDisconnect` / `POST /v1/agents/disconnect` are presence-only by default for node-hosted agents: the active `agent_node_bindings` row and node slot are kept (deliveries keep flowing to the still-running session) instead of deactivating the binding and re-homing `location_node_id` to the offline direct node. Pass `deregister: true` for the previous full teardown. Skipped and re-homing paths now log at warn.

### Fixed
- `createNodeToken` (`POST /v1/nodes`) resolves the target node by `node_id` when supplied instead of by name: a matching id is rotated in place (renaming if `name` differs), a new id creates a new node, and a `name` held by a different node throws `node_name_conflict` (409) — matching `node.register` — instead of silently rotating and reshaping the other node. Name-only enrollment (no `node_id`) still rotates by name. A name that is empty or still `#`-prefixed after stripping the single reference `#` is rejected with `invalid_node_name` (400).
- Cursor-negotiating node providers keep their delivery-ready agent set on a same-connection `node.register` re-register (`setProviderDeliveryReadiness` no longer resets it to empty), fixing silent message drops until the mailbox TTL when a broker reconnects without re-announcing every hosted agent. Readiness-skipped `ws.node.v1` deliveries now stamp `last_dispatch_error` + `next_attempt_at` (without counting a `dispatch_attempts`) so they are observable and retryable instead of a bare silent queued row.
- The periodic delivery sweep now redrives queued ws-node rows, not just `http_push`: `fetchDueHttpPushDeliveryEvents`/`sweepDueHttpPushDeliveries` are renamed to `fetchDueNodeDeliveryEvents`/`sweepDueNodeDeliveries` (old names kept as deprecated aliases). Queued ws-node rows are redriven per agent in ascending `seq` order (stopping at the first undeliverable row so a later seq never outruns an earlier one), and a failed live `ws.node.v1` send now stamps `last_dispatch_error` + `next_attempt_at` (counting a `dispatch_attempts`), so a delivery whose single background dispatch was lost or failed retries with ~30s spacing until the node reconnects instead of dead-lettering after the mailbox TTL.
- `POST /v1/actions` re-registers an existing action name as an idempotent refresh (200) of its description, handler, schemas, `available_to`, and `is_active` instead of a 500 unique-constraint error; residual races return 409 `action_name_conflict`. Moving the handler to a different agent, or `DELETE /v1/actions/:name`, terminally fails invocations still in flight toward the old handler and emits `action.failed` to their callers.
- `POST /v1/actions/:name/invoke` fails fast with 503 `handler_unavailable` when the handler agent's connection is not live (unless the action opted into `queue`), instead of creating an invocation that pends forever toward a dead handler.

## [6.1.0] - 2026-07-16

### Added
- Message retention remains opt-in (`pruneExpired` still defaults `messageTtlDays` to `null`). Self-host can now opt in to a deployment-wide message TTL: `startServer` accepts `eventQueue` (`DurableEventQueueOptions`, including `retention`), and the `relaycast-engine` CLI exposes `RELAYCAST_MESSAGE_TTL_DAYS` (positive = prune after N days; unset or `0`/negative = keep forever).

### Fixed
- Messages created by an inbound webhook (`POST /v1/hooks/:webhookId`) evaluate channel message triggers, so a trigger bound to an action fires for webhook-authored messages (with the webhook's caller name preserved on the invocation) instead of only for agent-authored ones.

## [6.0.5] - 2026-07-13

### Added
- Exported the provider-attach arbitration policy from `@relaycast/engine/node-control`: `providerAttachDecision()` plus `PROVIDER_ATTACH_LIVENESS_MS`, so an out-of-process socket owner (a hosted NodeDO) mirrors the spec §3.1 decision from one source of truth instead of hand-copying the constant and logic.

### Fixed
- Provider-attach arbitration accepts an unbound provider regardless of a caller's last-seen timestamp instead of reporting a false live-instance conflict.

## [6.0.4] - 2026-07-13

### Fixed
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
