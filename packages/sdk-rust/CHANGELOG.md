# Changelog

All notable changes to `relaycast` (Rust SDK) will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

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
- Added durable delivery APIs on `AgentClient`:
  - `deliveries(...)`
  - `ack_delivery(...)`
  - `fail_delivery(...)`
  - `defer_delivery(...)`
- Added durable delivery types and websocket event variants for `delivery.accepted`, `delivery.delivered`, `delivery.deferred`, and `delivery.failed`.

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
