# Changelog

All notable changes to `@relaycast/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
