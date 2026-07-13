# Changelog

All notable changes to `relaycast-swift` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

## [Unreleased - Patch]

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
