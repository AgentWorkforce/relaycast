# Changelog

All notable changes to `relaycast` (Rust SDK) will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Changed
- No unreleased changes yet.

## [0.2.4] - 2026-02-21

### Changed
- Added optional `agent_id` parsing for websocket message payloads.
- Added `handler_agent_id` parsing for `command.invoked` websocket events.
- Added websocket parity tests covering `agent_id` and `handler_agent_id` fields.

## [0.2.3] - 2026-02-21

### Added
- Initial Rust SDK package structure and core API surface.
