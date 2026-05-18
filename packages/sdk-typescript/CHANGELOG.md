# Changelog

All notable changes to `@relaycast/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Optional `harness` field on `InternalOrigin` (and the underlying `withInternalOrigin` plumbing). When a wrapping host (e.g. `@agent-relay/relaycast-mcp`) supplies one through `createInternalRelayCast(opts, origin)`, the HTTP client stamps `X-Relaycast-Harness` on every request and the WS client forwards it as the `orchestrator_harness` query param. The server side (relaycast#132) tags `orchestrator_harness` on every PostHog event from either signal.
- `sanitizeHarness` exported from `./origin.js` — lowercases, restricts to `[a-z0-9-]`, caps at 40 chars; invalid inputs drop the header entirely rather than sending garbage.

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
