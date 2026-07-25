# Changelog

All notable changes to `@relaycast/types` will be documented in this file.

See the [root changelog](../../CHANGELOG.md) for cross-package release highlights.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased - Minor]

### Added

- `AgentExitedEventSchema`, `NodeStatusOnlineEventSchema`, and `NodeStatusOfflineEventSchema` added to `ServerEventSchema` / `WsClientEventSchema`, and `agent.exited` / `node.status.online` / `node.status.offline` added to `SubscribableEventTypeSchema` so webhooks can subscribe to them.
- `SERVER_TELEMETRY_EVENTS` and `ServerTelemetryEventName` gain the 14 `relaycast_server_*` names the engine emits for actions, routing, the agent directory, channel mute/unmute, and inbound Relayfile delivery; `parseInternalTelemetryEvent` previously rejected them as unknown.

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
