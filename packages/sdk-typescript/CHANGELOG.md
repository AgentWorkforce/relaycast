# Changelog

All notable changes to `@relaycast/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Reconnect resync: `WsClient` now tracks the server-stamped `agent_seq` on delivered events and, after every reconnect, sends a `resync` frame so the server replays events missed during the disconnect window. Replayed events flow through the normal handlers, deduplicated by stable event id. First connections are unchanged (no resync until an event has been seen).
- `resynced` lifecycle event on `WsClient`, plus `on.resynced(({ replayed, gapDetected }) => ...)` on `RelayCast` and `AgentClient`, reporting how many events were replayed and whether the gap exceeded the server's replay buffer.
- Package README with install, `RelayCast` vs `AgentClient` quickstart, and reconnect/resync behavior.
- Optional `harness` field on `RelayCastOptions`/`ClientOptions` and `WsClientOptions` (plus the internal `InternalOrigin` plumbing). A User-Agent-style identifier for the harness driving requests (e.g. `'claude-code/2.3 (model=opus-4.8)'`, `'codex'`, `'human'`); stamped as the `X-Relaycast-Harness` HTTP header and forwarded as the `harness` WS query param so server-side telemetry can attribute traffic. When a wrapping host supplies one via the internal origin it takes precedence over the public option. Invalid values (empty, control characters) are dropped rather than sent; the header is omitted entirely when no harness is set, so existing consumers are unchanged on the wire.
- `sanitizeHarness` and `HARNESS_HEADER` exported from the SDK root — lowercases, restricts to a UA-safe character set, caps at 120 chars.
- Workspace-key realtime on `RelayCast`: `connect()`, `disconnect()`, and typed `on.*` handlers now open `/v1/ws` with the workspace key and expose workspace stream events.
- Fleet node roster on `RelayCast`: `nodes.list({ capability?, name? })`, `nodes.get(name)`, and `triggers.list()`, backed by the new `GET /v1/nodes` surface. New exported types `NodeRosterEntry`, `NodeCapability`, `NodeListQuery`, `Trigger`, and `CreateTriggerRequest`. Node capabilities are structured objects (`{ name, kind?, metadata? }`), never bare capability-name strings, matching the runtime.
- Action invocations now report which fleet node handled and dispatched the work: `handlerNode`, `handlerNodeId`, and `dispatchedNodeId`.
- `JsonValue` exported from the package root — the JSON value type used for action invocation output.

### Breaking
- Removed snake_case input aliases from the SDK surface; camelCase is now the only supported input style.
- Action invocation `output` is now typed `JsonValue` (any JSON value — scalar, array, `null`, or object) instead of `Record<string, unknown> | null`. Consumers that assumed action output was always an object must narrow before indexing.
- Durable delivery `status` values changed (the engine's delivery state machine was reworked for fleet location routing): `accepted` and `deferred` are no longer emitted, `acked` and `dead_lettered` are new, and `delivered` now means "sent to the current location, awaiting cumulative ack" rather than the previous terminal-success meaning (that state is now `acked`). The SDK surfaces `status` as a string, so this is a value/semantics change, not a type change — code that matched on `'accepted'`/`'deferred'` or treated `'delivered'` as terminal must update. See `@relaycast/types` for the full mapping.

### Changed
- Standardized SDK consumer-facing parameter casing to camelCase.
- Added SDK-wide request/response casing translation:
- Request bodies and query params now accept camelCase and are translated to API snake_case on the wire.
- All REST and WebSocket payloads exposed by the SDK are now camelCase.
- Normalized core SDK request options to camelCase (`includeArchived`, `contentType`, `sizeBytes`, `uploadedBy`, `handlerAgent`, `paymentMethod`).
- Exported camelized SDK type aliases from the package root.
- Updated tests to keep camelCase as the canonical SDK style.
- Added `RelayCast.lookupWorkspace()` and `RelayCast.ensureWorkspace()` for name-based workspace setup flows.

## [0.3.2] - 2026-02-20

### Added
- Current published SDK release baseline.
