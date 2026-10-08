# Changelog

All notable changes to `relaycast-swift` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

## [Unreleased]

## [9.0.0] - 2026-10-06

### Added

- `CreateNodeRequest.machineId` and `nodes.create(request, currentToken:idempotencyKey:)` support machine-aware enrollment and recoverable rotation without placing credentials in JSON; unkeyed creates are never replayed after an ambiguous failure.

### Changed

- Automatic retries default to idempotent HTTP methods or requests carrying an idempotency key; unkeyed `POST` and `PATCH` requests are sent once unless a caller explicitly enables retries.

## [8.16.0] - 2026-10-01

- Workspace creation accepts arbitrary JSON metadata, and updates shallow merge metadata with top-level null values deleting keys.

## [7.0.0] - 2026-08-07

- `NodeRosterEntry.load` is optional; provider and direct-agent heartbeats no longer label placeholder utilization as measured.

## [6.1.0] - 2026-07-16

- Allowed agent models to decode the hosted lifecycle statuses used during realtime connection setup.

## [6.0.0] - 2026-07-09

- Added `NodeProvider` support for hosting agents and node-scoped actions from Swift.

## 0.1.0

- Added initial SwiftPM package.
- Added `RelayCast`, `AgentClient`, `HttpClient`, `WsClient`, core models, realtime event helpers,
  retrying REST requests, origin/harness headers, idempotency headers, and snake_case JSON wire
  encoding.
- Added focused unit tests for headers, casing, retries, API errors, high-level registration, and
  agent message sends.
