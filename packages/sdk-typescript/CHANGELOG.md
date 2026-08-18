# Changelog

All notable changes to `@relaycast/sdk` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased - Minor]

### Added

- Workspace creation accepts `expiresInSeconds` and returns the resulting expiry timestamp.
- `workspace.delete()` uses the id-scoped deletion endpoint and accepts an optional known workspace id.

## [8.0.1] - 2026-08-14

### Fixed

- `AgentClient.dms.conversations({ limit })` forwards the optional server-side result limit used by MCP DM-list callers.

## [8.0.0] - 2026-08-10

### Added

- `AgentClient.dm()` accepts structured `data` and returns public DM metadata, enabling versioned A2A extensions such as Ratify proofs and revocations.

### Changed

- `data` and `metadata` are now passed through verbatim, like `headers`, `input` and `input_schema`, instead of being snake_cased on send and camelCased on read. Their keys are caller-authored data: rewriting them corrupted any document whose field names are meaningful, and made signed payloads unverifiable — a `RevocationList` whose `revoked_certs` arrived as `revokedCerts` cannot be reconstructed, so its signature fails.

  Scope of the change: only **multi-word** keys differ, and only for callers reading or writing these fields through this SDK. A reader who previously saw `nodeId` for a stored `node_id` now sees `node_id`. Callers who wrote camelCase keys and read them back unchanged are unaffected, and callers who deliberately wrote snake_case keys were already getting a different key back — for them this is a fix.

## [7.0.0] - 2026-08-07

### Changed

- `NodeRosterEntry.load` is now `number | null`; provider and direct-agent heartbeats no longer label placeholder utilization as measured.

## [6.3.0] - 2026-07-28

### Added
- Client and workspace-bootstrap options accept `agentRelayMachineId`, `agentRelayUserId`, `agentRelayOrgId`, and `agentRelayOrgSlug`, sent as `X-Agent-Relay-*` headers on HTTP and as `agent_relay_*` query params on WebSocket upgrades. `agentRelayUserId` doubles as the distinct id when `agentRelayDistinctId` is unset; the machine id is always sent alongside the distinct id, never instead of it.

### Fixed
- Identity now reaches WebSocket connections, not just HTTP requests: `RelayCast` never forwarded it to its observer socket, and `AgentClient` forwarded only the distinct id to its `/v1/node/ws` socket, so agent sessions reported `ws_session_started` as unauthenticated.
- A malformed higher-priority identity value no longer shadows a valid lower-priority one; each source is validated before it wins.

## [6.2.0] - 2026-07-17

### Added
- `AgentClient.disconnect()` and `presence.markOffline()` accept an optional `{ deregister?: boolean }`. By default the disconnect is presence-only for node-hosted agents; pass `{ deregister: true }` to tear down the node binding and re-home the agent to its direct node.

### Fixed
- The request/response casing transforms no longer rewrite keys inside user-authored JSON values: action `input_schema`/`output_schema` (JSON Schemas), invocation `input`/`output` payloads, and `headers` maps pass through verbatim in both directions, so a camelCase-keyed schema round-trips byte-identical instead of being corrupted (e.g. `properties.batchSize` → `properties.batch_size`).

## [6.0.0] - 2026-07-09

### Added
- Added `NodeProvider`, `defineNode`, and related provider APIs for hosting agents and node-scoped actions from the TypeScript SDK.

## [5.0.10] - 2026-07-01

### Added
- Added the `useProxy` node-delivery option for routing `http_push` requests through the configured egress proxy.

## [5.0.7] - 2026-06-28

### Fixed
- Added `prepublishOnly` so publishing always rebuilds the SDK instead of uploading stale `dist` output.

## [4.0.0] - 2026-06-15

### Added
- Fleet node roster on `RelayCast`: `nodes.list({ capability?, name? })`, `nodes.get(name)`, and `triggers.list()`, backed by the new `GET /v1/nodes` surface. New exported types `NodeRosterEntry`, `NodeCapability`, `NodeListQuery`, `Trigger`, and `CreateTriggerRequest`. Node capabilities are structured objects (`{ name, kind?, metadata? }`), never bare capability-name strings, matching the runtime.
- Action invocations now report which fleet node handled and dispatched the work: `handlerNode`, `handlerNodeId`, and `dispatchedNodeId`.
- `JsonValue` exported from the package root — the JSON value type used for action invocation output.

### Breaking
- Action invocation `output` is now typed `JsonValue` (any JSON value — scalar, array, `null`, or object) instead of `Record<string, unknown> | null`. Consumers that assumed action output was always an object must narrow before indexing.
- Durable delivery `status` values changed (the engine's delivery state machine was reworked for fleet location routing): `accepted` and `deferred` are no longer emitted, `acked` and `dead_lettered` are new, and `delivered` now means "sent to the current location, awaiting cumulative ack" rather than the previous terminal-success meaning (that state is now `acked`). The SDK surfaces `status` as a string, so this is a value/semantics change, not a type change — code that matched on `'accepted'`/`'deferred'` or treated `'delivered'` as terminal must update. See `@relaycast/types` for the full mapping.

## [3.1.0] - 2026-06-10

### Added
- Reconnect resync: `WsClient` tracks the server-stamped `agent_seq` and requests replay after reconnect, deduplicated by stable event id.
- Added the `resynced` lifecycle event and typed handlers reporting replay count and buffer gaps.

## [2.5.0] - 2026-06-03

### Added
- Workspace-key realtime on `RelayCast` through `connect()`, `disconnect()`, and typed `on.*` handlers.

## [2.4.0] - 2026-06-03

### Added
- Optional sanitized harness attribution for HTTP and WebSocket traffic through `harness`, `sanitizeHarness`, and `HARNESS_HEADER`.

## [0.7.0] - 2026-03-24

### Added
- Added `RelayCast.lookupWorkspace()` and `RelayCast.ensureWorkspace()` for name-based workspace setup flows.

## [0.3.4] - 2026-02-26

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

## [0.3.2] - 2026-02-20

### Added
- Current published SDK release baseline.
