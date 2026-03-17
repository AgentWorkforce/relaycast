# Message Model Convergence (DM + Channel)

This document tracks convergence toward a single core message payload across channel and DM surfaces.

## Core payload

Shared fields:
- `id`
- `agent_id`
- `agent_name`
- `text`
- `injection_mode`

## This PR phase

- Introduces/reuses a shared `CoreMessagePayloadSchema` in `@relaycast/types`.
- Uses core payload for WS events (`message.updated`, `thread.reply`, `dm.received`, `group_dm.received`).
- Keeps channel-specific extensions (`attachments`) in channel payload.
- Makes **client-facing DM response models breaking** to converge on core message payloads:
  - `SendDmResponse` now expects `{ conversation_id, message, created_at }`
  - `GroupDmMessageResponse` now expects `{ conversation_id, message, created_at }`
- Keeps server wire compatibility for now; the breaking surface is in typed clients/models.

## Breaking changes in this PR (client major)

1. Removed legacy DM typed response fields in client models (`id`, `from_agent_id`, `to`, `text`, `injection_mode` at top level).
2. Consumers must read DM send payloads from nested `message` object.

## Future follow-ups

1. Normalize DM list responses to a full `MessageWithMeta`-style envelope.
2. Consolidate send endpoints around a shared request schema with thin convenience wrappers.
