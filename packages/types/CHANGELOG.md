# Changelog

All notable changes to `@relaycast/types` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [8.5.0] - 2026-09-06

### Added

- `ReleaseAgentRequest` accepts an optional lowercase SHA-256 `expected_token_hash` generation guard.

## [8.4.0] - 2026-09-05

### Changed

- `CreateWorkspaceResponse` now requires the `api_key` returned by workspace creation and authenticated idempotent replays.

## [8.3.0] - 2026-09-02

### Added

- `NODE_DELIVER_FRAME_EVENT_TYPES`, `NodeFrameKindSchema`, `isNodeDeliverFrameEventType`, and `nodeFrameKindFor` declare which event types nodes receive on the `deliver` frame (`message.created` and `thread.reply` durably; `message.read`, `message.reacted`, and the caller-addressed `action.completed`/`action.failed`/`action.denied`/`agent.exited`/`node.status.*` notifications best-effort); every other type travels as `context.update`.

## [8.2.0] - 2026-08-21

### Added

- Workspace schemas define creation provenance and internal/external/unknown usage classification.

## [8.1.0] - 2026-08-19

### Added

- `node.register` accepts placement-safe `repo_keys` and rejects path-shaped repository keys and tags. Keys are `owner/name` only; filesystem paths, UNC shares, clone URLs, and `.`/`..` segments are refused.

## [8.0.7] - 2026-08-19

### Added

- Added effective message-retention and session replay result schemas, including retained, partial, aged-out, and unknown availability.

## [8.0.6] - 2026-08-18

### Added

- Workspace creation and response schemas expose explicit expiry fields.

## [8.0.1] - 2026-08-14

### Added

- Declare the server audit event emitted after a legacy agent identity is claimed.

## [8.0.0] - 2026-08-10

### Added

- Direct-message requests accept structured `data`, and DM payloads expose the resulting public `metadata`.

## [7.0.0] - 2026-08-07

### Changed

- `node.heartbeat.load` may be absent or null when capacity utilization is unreported; `load_reported: true` explicitly identifies a numeric `[0,1]` value as a measurement while legacy placeholder numbers remain accepted but untrusted.

## [6.3.0] - 2026-07-28

### Added

- `SERVER_TELEMETRY_EVENTS` and `ServerTelemetryEventName` gain the 14 `relaycast_server_*` names the engine emits for actions, routing, the agent directory, channel mute/unmute, and inbound Relayfile delivery; `parseInternalTelemetryEvent` previously rejected them as unknown.

### Fixed

- Corrected the `fleet-wire/deliver.json` fixture payload to the `{type, data}` shape `buildDeliverPayload` emits, replacing the stale flat `{channel, text, sender, ...}` sample.

## [6.2.0] - 2026-07-17

### Added

- `AgentExitedEventSchema`, `NodeStatusOnlineEventSchema`, and `NodeStatusOfflineEventSchema` added to `ServerEventSchema` / `WsClientEventSchema`, and `agent.exited` / `node.status.online` / `node.status.offline` added to `SubscribableEventTypeSchema` so webhooks can subscribe to them.

## [6.0.3] - 2026-07-12

### Added

- `FLEET_DELIVERY_CURSOR_CAPABILITY` and optional `AgentRegisterReplyData.delivery_ack_seq` define the negotiated broker-restart cursor handshake while retaining the legacy reply shape.

## [4.0.0] - 2026-06-15

### Breaking

- `DeliveryStatus` reworked for the durable mailbox / fleet location routing.
  The enum changed from `['accepted', 'delivered', 'deferred', 'failed']` to
  `['queued', 'delivered', 'acked', 'failed', 'dead_lettered']`:
  - `accepted` and `deferred` are **removed** — a row awaiting handling is now
    `queued`.
  - `acked` and `dead_lettered` are **added** — `acked` is the terminal success
    state; `dead_lettered` is the terminal TTL-expiry state.
  - `delivered` **changed meaning**: it now means "sent to the current location,
    awaiting cumulative ack", not the previous terminal-success meaning (that is
    now `acked`).

  | Old value   | New value | Notes                                  |
  | ----------- | --------- | -------------------------------------- |
  | `accepted`  | `queued`  | awaiting handling                      |
  | `deferred`  | `queued`  | retry windows tracked via `available_at` |
  | `delivered` | `acked`   | previous terminal success → `acked`    |
  | `delivered` | `delivered` | new meaning: sent, awaiting ack      |
  | `failed`    | `failed`  | unchanged                              |
  | —           | `dead_lettered` | new: TTL-expiry terminal failure |

  The engine migration (`0019_fleet_mailbox`) rewrites existing rows
  (`accepted`/`deferred` → `queued`, prior `delivered` → `acked`), so consumers
  reading `/v1/deliveries` see the new values after the engine deploys
  **regardless of the per-workspace fleet flag**. Code that matched on
  `accepted`/`deferred`, or treated `delivered` as terminal, must update.

### Added

- `DeliverySchema` gains fleet location and lifecycle fields: `seq`,
  `location_type`, `location_node_id`, `expires_at`, `delivered_at`, `acked_at`,
  and `dead_lettered_at`.
- `fleet-wire.ts` — the fleet node-control wire protocol, exported from the
  package root. Discriminated-union schemas/types for the node ↔ engine control
  channel: `node.register`/`heartbeat`/`deregister`, `agent.register`/`deregister`,
  `delivery.ack`, `action.invoke`/`action.result`, `inventory.sync`, `deliver`,
  `ping`, and the `reply`/`error` correlation frames, plus `FleetCapability`
  (`{ name, kind?, metadata? }`), `FleetWireJsonValue`, and
  `AgentRegisterReplyData` (`{ agent_id, token, name?, delivery_ack_seq? }`). Field casing is
  snake_case throughout.

## [3.1.1]

- Baseline: first release tracked in this changelog.
