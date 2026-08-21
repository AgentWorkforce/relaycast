# Changelog

All notable changes to `relaycast` (Rust SDK) will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased - Major]

### Changed

- **BREAKING:** `RelayCast::rotate_agent_token` now requires the current agent token; use `take_over_agent` or `recover_agent` to replace an identity you cannot authenticate as.
- **BREAKING:** `AgentRegistrationClient::register_agent_token` is create-only and returns `AgentRegistrationError::AlreadyExists` on conflicts; use a unique name or persist the token for self-rollover.
- `NodeRosterEntry.load` is now `Option<f64>`, matching the API's explicit unreported state; direct-agent heartbeats no longer label a constant utilization as measured.

### Added

- `RelayCast::create_workspace` now requires explicit provenance, preventing CLI bootstrap workspaces from being mislabeled as SDK-created.

## [4.2.0] - 2026-06-24

### Added
- Added `node_control_ws_url(base_url: Option<&str>)`, which builds the fleet node-control WebSocket URL (`{ws_base}/v1/node/ws`), applying the hosted default and `https`→`wss` rewrite when no base is given. Lets callers reach the node-control endpoint without knowing the hosted host or scheme.

## [2.3.0] - 2026-06-09

### Added
- Added optional `harness` identifier on `RelayCastOptions`/`ClientOptions` and `WsClientOptions` via `with_harness(...)`, plus `sanitize_harness(...)` and the `HARNESS_HEADER` constant. A User-Agent-style identifier for the harness driving requests (e.g. `"claude-code/2.3 (model=opus-4.8)"`, `"codex"`, `"human"`); sent as the `X-Relaycast-Harness` HTTP header and forwarded as the `harness` WS query param so server-side telemetry can attribute traffic. Invalid values (empty, control characters) are dropped; the header/param is omitted entirely when unset, and the value survives `HttpClient::with_api_key(...)`. Brings the Rust SDK to parity with `@relaycast/sdk`.

## [2.1.0] - 2026-06-03

### Added
- Added durable delivery APIs on `AgentClient`: `deliveries(...)`, `ack_delivery(...)`, `fail_delivery(...)`, and `defer_delivery(...)`.
- Added durable delivery types and websocket event variants for `delivery.accepted`, `delivery.delivered`, `delivery.deferred`, and `delivery.failed`.

## [1.1.0] - 2026-05-19

### Added
- Added raw WebSocket event subscriptions with `WsClient::subscribe_raw_events()` and `RawEventReceiver`.
- Added SDK-owned raw event normalization helpers:
  - `normalize_inbound_event(...)`
  - `normalize_command_invocation(...)`
  - `normalize_sender_identity(...)`
  - `NormalizedInboundEvent`, `NormalizedCommandInvocation`, `NormalizedEventKind`, `SenderKind`, and `RelayPriority`
- Added identity helpers `agent_name_eq(...)` and `is_self_name(...)`.
- Added `AgentRegistrationClient::registered_agent_client(...)` for cached/spawned token registration followed by agent-client construction.
- Added idempotent channel startup helpers `AgentClient::ensure_joined_channel(...)` and `AgentClient::ensure_joined_channels(...)`.
- Added `DmParticipantsCache` for bounded workspace DM participant lookup caching.

## [1.0.1] - 2026-05-10

### Changed
- Made `agent.spawn_requested` websocket parsing tolerant of missing or `null` `task`, `channel`, and `already_existed` fields.
- Kept `AgentSpawnRequestedPayload.task` as a `String` for API compatibility by deserializing missing or `null` values to an empty string.
- Added websocket parity coverage for tolerant spawn-request event parsing.

## [0.2.6] - 2026-02-25

### Added
- Added a new `credentials` module with file-backed credential persistence and session bootstrapping APIs:
  - `CredentialStore`
  - `BootstrapConfig`
  - `bootstrap_session(...)`
- Added local runtime support in `RelayCastOptions`:
  - `RelayCastOptions::local(...)`
  - `RelayCastOptions::with_local(...)`
  - Auto-bootstrap and health checks for local daemon startup.
- Added `RelayError` helper methods for API-aware handling:
  - `is_rate_limited()`
  - `is_not_found()`
  - `is_auth_rejection()`
  - `is_conflict()`
  - `status()`
  - `code()`
- Added parity coverage for local option defaults and credential store behavior.

### Changed
- `RelayError::WebSocket` now stores boxed tungstenite errors.
- Updated WebSocket send calls for current tungstenite message text API compatibility.
- Enabled `reqwest` blocking client support to allow local daemon health checks during client initialization.

## [0.2.5] - 2026-02-22

### Added
- Added WebSocket lifecycle events with `subscribe_lifecycle()` and `WsLifecycleEvent` (`Open`, `Close`, `Error`, `Reconnecting`).
- Added configurable WebSocket reconnect settings in `WsClientOptions` (`max_reconnect_attempts`, `max_reconnect_delay_ms`).
- Added runtime token update APIs for long-lived clients: `WsClient::set_token(...)` and `AgentClient::set_token(...)`.
- Added typed DM helper methods on `AgentClient`:
  - `dm_typed(...)`
  - `create_group_dm_typed(...)`
  - `send_dm_message_typed(...)`
  - `add_dm_participant_typed(...)`
- Added typed DM response structs:
  - `DmSendResponse`
  - `GroupDmConversationResponse`
  - `GroupDmMessageResponse`
  - `GroupDmParticipantResponse`
  - `GroupDmParticipantRef`

### Changed
- WebSocket client now reconnects automatically with exponential backoff and re-subscribes previously subscribed channels after reconnect.
- `DmConversationSummary` parsing now supports both string and object forms for `participants`, and string/object forms for `last_message`.
- Group DM participant add endpoint payload now uses `agent_name` for wire compatibility.
- Expanded Rust SDK parity tests for DM payload compatibility and participant add request shape.

## [0.2.4] - 2026-02-21

### Changed
- Added optional `agent_id` parsing for websocket message payloads.
- Added `handler_agent_id` parsing for `command.invoked` websocket events.
- Added websocket parity tests covering `agent_id` and `handler_agent_id` fields.

## [0.2.3] - 2026-02-21

### Added
- Initial Rust SDK package structure and core API surface.
