# Changelog

All notable changes to `@relaycast/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional `harness` field on `RelayCastOptions`/`ClientOptions` and `WsClientOptions` (plus the internal `InternalOrigin` plumbing). A User-Agent-style identifier for the harness driving requests (e.g. `'claude-code/2.3 (model=opus-4.8)'`, `'codex'`, `'human'`); stamped as the `X-Relaycast-Harness` HTTP header and forwarded as the `harness` WS query param so server-side telemetry can attribute traffic. When a wrapping host supplies one via the internal origin it takes precedence over the public option. Invalid values (empty, control characters) are dropped rather than sent; the header is omitted entirely when no harness is set, so existing consumers are unchanged on the wire.
- `sanitizeHarness` and `HARNESS_HEADER` exported from the SDK root — lowercases, restricts to a UA-safe character set, caps at 120 chars.
- Workspace-key realtime on `RelayCast`: `connect()`, `disconnect()`, and typed `on.*` handlers now open `/v1/ws` with the workspace key and expose workspace stream events.

### Breaking
- Removed snake_case input aliases from the SDK surface; camelCase is now the only supported input style.

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
