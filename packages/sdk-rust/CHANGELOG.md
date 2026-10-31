# Changelog

All notable changes to `relaycast` (Rust SDK) will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased - Major]

### Added

- `RelayCast::upgrade_credential` and `RelayCast::upgrade_credential_with`: exchange a legacy credential for the `ar_` credential of the same principal through `POST /v1/credentials/upgrade`; return `CredentialUpgradeResponse`.

### Removed

- `Workspace::plan`; servers no longer return it.

### Fixed

- Registration CLI hints and defaults preserve `opencode`, `grok`, `muse`, and `devin` instead of falling back to another harness.
- WebSocket connects and reconnects share one TLS configuration per process, so `wss://` reconnects no longer reload the platform root certificates (about 120 ms of CPU per reconnect on macOS). A platform with no roots still fails that connect and is read again on the next.

## [10.0.0] - 2026-10-15

### Added

- `RelayError::Api` keeps the full parsed JSON error body in a new `details: Option<serde_json::Value>` field, exposed through `RelayError::details()`. Server metadata beyond `error.code`/`error.message` now reaches callers, for example the top-level `plan`, `upgrade_available` and `upgrade_url` that workspace admission 429s (`workspace_busy`) carry, so an app can use the server's upgrade decision instead of guessing from the plan. `details` is `None` for non-JSON error bodies and for errors the SDK builds itself (`RelayError::api(...)`, cached-credential and registration guards).

### Changed

- **BREAKING:** `RelayError::Api` gained the `details` field. Code that constructs the variant with a struct literal must add `details: None` (or use `RelayError::api(code, message, status)`), and patterns that destructure it without a trailing `..` must add one, e.g. `RelayError::Api { code, message, status, .. }`.
- Workspace creation and by-name workspace lookup decode their response body with `serde_json` after reading it, so a malformed body on those two calls surfaces as `RelayError::Json` instead of `RelayError::Http`. Retry and admission behavior is unchanged.

### Fixed

- Distinguish an explicit null acknowledgement from a missing `data` field, and preserve API errors before decoding the expected success payload.

## [9.0.1] - 2026-10-14

### Fixed

- Acknowledgement responses `{ "ok": true, "data": null }` succeed for calls whose result admits null (`Value`, `()`, `Option<_>`), so `AgentClient::heartbeat()` no longer reports "Response missing data field" after the server refreshed presence. Typed payloads still reject null data.

## [9.0.0] - 2026-10-13

### Added

- `AgentRegistrationClient::invalidate_cached_registration_if_token_hash()` atomically removes only the cached credential generation whose SHA-256 hash matches, preserving concurrent same-name replacement registrations.
- `RelayCast::create_node_with_current_token` sends current-node proof for authorized rotation or modification of an established node without placing the credential in the JSON body. `create_node_with_rotation_recovery` also sends a caller-retained idempotency key for lost-response recovery, and `CreateNodeRequest` now exposes optional `machine_id`.
- `WorkspaceBootstrapOptions::with_origin(client, version)` and `RelayCast::lookup_workspace_with_options(WorkspaceLookupOptions)` identify products on anonymous workspace creation and lookup; legacy calls retain SDK defaults.
- `RelayCastOptions::with_origin(client, version)` and `AgentClient::with_options(ClientOptions)` configure product attribution, inherited by agent HTTP/WebSocket traffic and preserved across token replacement.

### Changed

- Workspace creation accepts arbitrary JSON metadata, and updates shallow merge metadata with top-level null values deleting keys.
- **BREAKING:** `RelayCastOptions` and `WorkspaceBootstrapOptions` struct literals must include the new `origin_client` and `origin_version` fields; prefer `RelayCastOptions::new(...)` and builders.

### Fixed

- `all_dm_conversations()` follows bounded server cursors and still returns the complete conversation vector, with a malformed-cursor progress guard.
- Workspace reads and updates accept current engine responses that omit the private API key hash.

## [8.0.1] - 2026-09-19

### Added

- `RelayCast::emit_agent_event_with_idempotency_key` preserves a stable event key across retries.
- `WorkspaceBootstrapOptions` and `RelayCast::create_workspace_with_options()` support crash-safe anonymous keyed workspace creation without a deployment-wide secret, plus opt-in self-host proof via `with_bootstrap_secret(...)`; the SDK never sends that proof to hosted Relaycast.
- `RelayCast::release_agent_if_token_hash` performs generation-safe cleanup without changing the existing `ReleaseAgentRequest` struct.
- `RelayCast::release_agent_exact()` performs immutable-id, idempotent agent-release reconciliation.

### Fixed

- Anonymous keyed workspace bootstrap rejects remote HTTP and redirects, preventing its recovery capability from reaching another origin.
- `RelayError::retry_after_ms()` exposes the authoritative server delay for exact-release overload handling.
- Agent registration now honors bounded server `Retry-After` cooldowns and waits for that same cooldown before retrying.
- Workspace write-admission denials (`workspace_busy`, `workspace_admission_unavailable`) are retried on the server's own `Retry-After` pacing, including for unkeyed mutations. Admission rejects before the handler runs, so nothing was applied; previously a momentary denial was terminal and left calls such as agent/node binding permanently unapplied.

## [8.0.0] - 2026-09-06

### Changed

- Automatic 5xx retries require an idempotent request or an idempotency key.
- **BREAKING:** `RelayError::Api` gained `request_id: Option<String>` and `attempts: u32` fields (also exposed via new `RelayError::request_id()`/`RelayError::attempts()` accessors); match arms that destructure it exhaustively need a trailing `..`.

### Fixed

- Retryable HTTP failures retain the final status, API error, request metadata, and attempt count after retries are exhausted.
- Retried 5xx responses honor a bounded `Retry-After` delay.

## [7.0.0] - 2026-08-21

### Added

- `RelayCast::create_workspace` now requires explicit provenance, preventing CLI bootstrap workspaces from being mislabeled as SDK-created.

### Changed

- **BREAKING:** `RelayCast::rotate_agent_token` now requires the current agent token; use `take_over_agent` or `recover_agent` to replace an identity you cannot authenticate as.
- **BREAKING:** `AgentRegistrationClient::register_agent_token` is create-only and returns `AgentRegistrationError::AlreadyExists` on conflicts; use a unique name or persist the token for self-rollover.
- `NodeRosterEntry.load` is now `Option<f64>`, matching the API's explicit unreported state; direct-agent heartbeats no longer label a constant utilization as measured.

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
