# Message Model Convergence (DM + Channel)

This document tracks convergence toward a single core message payload across channel and DM surfaces.

## Core payload

Shared fields:
- `id`
- `agent_id`
- `agent_name`
- `text`
- `injection_mode`

## Current convergence state

- Shared `CoreMessagePayloadSchema` is used for WS events (`message.updated`, `thread.reply`, `dm.received`, `group_dm.received`).
- DM typed responses converge on nested message payloads:
  - `SendDmResponse` => `{ conversation_id, message, created_at }`
  - `GroupDmMessageResponse` => `{ conversation_id, message, created_at }`
- Server currently returns canonical fields plus legacy compatibility fields.

## Required client migration

1. DM typed consumers should read from nested `message` instead of legacy top-level fields.
2. Plan for legacy field removal in the next major release.

## Attachments policy (DM + threads)

Current state:
- DM and group-DM send requests support `attachments` file-id arrays.
- DM/group-DM persistence and response/event payloads include attachments.
- TypeScript + Python SDK DM helpers support attachments.

Remaining parity work:
1. Add thread-reply attachment support end-to-end.
2. Add full Rust DM attachment helper parity in public API ergonomics.
3. Align all helper signatures (`send`, `reply`, `dm`) for symmetric attachment options.
